import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join, normalize, resolve, sep } from "node:path"

import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { Layer } from "effect"
import { config as loadEnv } from "dotenv"

import { EVIDENCE_DIR, REPO_ROOT } from "../paths.js"
import { makeApiLayer } from "./handlers.js"
import { Orchestrator } from "./orchestrator.js"

loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true })

/**
 * The orchestrator server.
 *
 * One port serves three things, because they are three views of the same run and
 * splitting them across processes would only create a way for them to disagree:
 *
 *   /api/…                the typed contract, implemented by real handlers
 *   /evidence/<run>/<f>   the redacted artefacts a run produced
 *   ws://…/takeover       co-browsing, on a socket the session names
 *
 * The takeover socket is *not* here: each live session opens its own, and the
 * intervention tells the console where. That is deliberate — a session is a
 * browser, and a browser that has gone away should take its socket with it
 * rather than leave a dead path on a shared server.
 */

const PORT = Number(process.env["PORT"] ?? 4000)

/**
 * The console runs on a different origin in development.
 *
 * Permissive on purpose and only here: this is an internal operator tool bound
 * to loopback, and the thing that actually guards the automation is the policy
 * chokepoint, not the browser's origin check.
 */
const cors = (response: ServerResponse): void => {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  // `traceparent` and `b3` are added by the client's own tracing. A preflight
  // that does not list them fails, and the failure looks exactly like the API
  // being down — which is how this was found.
  response.setHeader(
    "access-control-allow-headers",
    "content-type,traceparent,b3,tracestate"
  )
}

/**
 * Serve one file out of an evidence directory.
 *
 * The path is resolved and then checked to still be *inside* the evidence root.
 * Without that, `/evidence/../../.env` is a credential disclosure — and this
 * server sits on a machine that holds banking credentials by design.
 */
const serveEvidence = async (
  path: string,
  response: ServerResponse
): Promise<void> => {
  const relative = decodeURIComponent(path.replace(/^\/evidence\//, ""))
  const target = resolve(EVIDENCE_DIR, normalize(relative))

  if (!target.startsWith(resolve(EVIDENCE_DIR) + sep)) {
    response.writeHead(403).end("outside the evidence root")
    return
  }

  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) {
    response.writeHead(404).end("no such evidence")
    return
  }

  const type = target.endsWith(".png")
    ? "image/png"
    : target.endsWith(".json")
      ? "application/json"
      : "text/plain; charset=utf-8"

  response.writeHead(200, { "content-type": type })
  createReadStream(target).pipe(response)
}

/** Node's request object, as the web `Request` the Effect handler expects. */
const toWebRequest = (
  request: IncomingMessage,
  body: Buffer
): Request =>
  new Request(new URL(request.url ?? "/", `http://localhost:${PORT}`), {
    method: request.method,
    headers: Object.entries(request.headers).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, Array.isArray(value) ? value.join(",") : value] as [string, string]]
    ),
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(body),
  })

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolveBody) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolveBody(Buffer.concat(chunks)))
  })

const main = async (): Promise<void> => {
  const orchestrator = new Orchestrator()

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(makeApiLayer(orchestrator), HttpServer.layerContext)
  )

  const server = createServer((request, response) => {
    cors(response)

    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }

    const path = (request.url ?? "/").split("?")[0] ?? "/"

    if (path.startsWith("/evidence/")) {
      void serveEvidence(path, response)
      return
    }

    void (async () => {
      const body = await readBody(request)
      const result = await handler(toWebRequest(request, body))

      response.writeHead(
        result.status,
        Object.fromEntries(result.headers.entries())
      )
      response.end(Buffer.from(await result.arrayBuffer()))
    })()
  })

  server.listen(PORT, () => {
    console.log(`cua orchestrator  http://localhost:${PORT}/api`)
    console.log(`evidence          http://localhost:${PORT}/evidence/<run>/<file>`)
  })

  const shutdown = async () => {
    server.close()
    await orchestrator.close()
    await dispose()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

void main()
