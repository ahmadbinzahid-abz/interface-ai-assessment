import { beforeEach, describe, expect, it } from "vitest"

import { createApp } from "../src/app.js"
import { resetMembers } from "../src/data/members.js"
import { armFault, resetFaults } from "../src/faults.js"
import { resetSessions } from "../src/session.js"

/**
 * The stand-in app is a test fixture, so its behaviour is itself worth pinning
 * down: every branch the replay engine will be asked to distinguish has to be
 * reachable and has to look the way the artifact expects.
 *
 * These run through the real Hono app in-process — no port, no browser. Browser
 * level behaviour (frames, accessibility tree, locator resolution) is Phase 2's
 * concern and is tested there.
 */

const app = createApp()

/** Minimal cookie-carrying client, so a signed-in session survives requests. */
class Client {
  private cookie: string | undefined

  async get(path: string): Promise<Response> {
    return this.send(path, { method: "GET" })
  }

  async post(
    path: string,
    fields: Record<string, string> = {}
  ): Promise<Response> {
    return this.send(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    })
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookie) headers.set("cookie", this.cookie)

    const response = await app.request(path, { ...init, headers })

    const setCookie = response.headers.get("set-cookie")
    if (setCookie) this.cookie = setCookie.split(";")[0]

    return response
  }

  async signOn(tenant = "firstcity"): Promise<void> {
    const response = await this.post(`/${tenant}/login`, {
      f1_ctl01: "teller01",
      f1_ctl02: "demo-pass",
    })
    expect(response.status).toBe(303)
  }
}

const signedOn = async (tenant = "firstcity"): Promise<Client> => {
  const client = new Client()
  await client.signOn(tenant)
  return client
}

beforeEach(() => {
  resetFaults()
  resetSessions()
  resetMembers()
})

describe("sign on", () => {
  it("rejects a bad password", async () => {
    const response = await new Client().post("/firstcity/login", {
      f1_ctl01: "teller01",
      f1_ctl02: "wrong",
    })

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toContain(
      "Invalid operator ID or password"
    )
  })

  it("refuses the desk without a session", async () => {
    const response = await new Client().get("/firstcity/desk/search")

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain("Your session has expired")
  })
})

describe("the desk is a frameset", () => {
  it("serves a frameset naming the content frame", async () => {
    const client = await signedOn()
    const html = await (await client.get("/firstcity/desk")).text()

    expect(html).toContain("<frameset")
    expect(html).toContain('name="contentFrame"')
    // A frameset document must not carry a body, or the frames never render.
    expect(html).not.toContain("<body")
  })
})

describe("member search", () => {
  it("finds a member and redirects to the detail page", async () => {
    const client = await signedOn()
    const response = await client.post("/firstcity/desk/search", {
      f1_ctl03: "12345",
    })

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      "/firstcity/desk/member/12345"
    )
  })

  it("reports an unknown member as a result, not an error", async () => {
    const client = await signedOn()
    const response = await client.post("/firstcity/desk/search", {
      f1_ctl03: "99999",
    })

    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toContain(
      "No member found for 99999"
    )
  })

  it("reports a restricted member as a permission denial", async () => {
    const client = await signedOn()
    const response = await client.post("/firstcity/desk/search", {
      f1_ctl03: "55555",
    })

    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toContain("is restricted")
  })
})

describe("member detail", () => {
  it("renders the savings balance the capability extracts", async () => {
    const client = await signedOn()
    const html = await (await client.get("/firstcity/desk/member/12345")).text()

    expect(html).toContain("Dana Whitfield")
    expect(html).toContain("$4,812.65")
  })

  it("exposes an irreversible control for the policy engine to refuse", async () => {
    const client = await signedOn()
    const html = await (await client.get("/firstcity/desk/member/12345")).text()

    expect(html).toContain('value="Close Account"')
  })
})

describe("opening a sub-account", () => {
  it("rejects a deposit below the minimum", async () => {
    const client = await signedOn()
    const response = await client.post(
      "/firstcity/desk/member/12345/subaccount",
      {
        f1_ctl11: "Regular Savings",
        f1_ctl12: "10",
        f1_ctl13: "Trip",
      }
    )

    expect(response.status).toBe(422)
    await expect(response.text()).resolves.toContain("at least $25.00")
  })

  it("reaches the confirmation screen and issues an account number", async () => {
    const client = await signedOn()
    const html = await (
      await client.post("/firstcity/desk/member/12345/subaccount", {
        f1_ctl11: "Regular Savings",
        f1_ctl12: "150",
        f1_ctl13: "Trip",
      })
    ).text()

    expect(html).toContain("Sub-account opened successfully")
    expect(html).toContain("S-0003-12345")
  })
})

describe("injected runtime conditions", () => {
  it("shows an interstitial once, then clears", async () => {
    const client = await signedOn()
    armFault("interstitial")

    const interrupted = await (
      await client.get("/firstcity/desk/search")
    ).text()
    expect(interrupted).toContain("Scheduled maintenance")
    expect(interrupted).toContain('value="Continue"')

    const recovered = await (await client.get("/firstcity/desk/search")).text()
    expect(recovered).toContain("Member Number")
  })

  it("signals session expiry in the body with a 200, not a status code", async () => {
    const client = await signedOn()
    armFault("session-expired")

    const response = await client.get("/firstcity/desk/search")

    // The nasty case: a status-code-only check would call this success.
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain("Your session has expired")
  })

  it("surfaces a hard application error", async () => {
    const client = await signedOn()
    armFault("server-error")

    const response = await client.get("/firstcity/desk/search")

    expect(response.status).toBe(500)
    await expect(response.text()).resolves.toContain("CB-500-8842")
  })

  it("lets the core reject an otherwise valid submission", async () => {
    const client = await signedOn()
    armFault("validation")

    const response = await client.post(
      "/firstcity/desk/member/12345/subaccount",
      {
        f1_ctl11: "Regular Savings",
        f1_ctl12: "150",
        f1_ctl13: "Trip",
      }
    )

    expect(response.status).toBe(422)
    await expect(response.text()).resolves.toContain(
      "not available for this member"
    )
  })

  it("only fires an armed fault the requested number of times", async () => {
    const client = await signedOn()
    armFault("server-error", 2)

    expect((await client.get("/firstcity/desk/search")).status).toBe(500)
    expect((await client.get("/firstcity/desk/search")).status).toBe(500)
    expect((await client.get("/firstcity/desk/search")).status).toBe(200)
  })
})

describe("a second tenant on the same vendor product", () => {
  it("renames the fields a locator would key on", async () => {
    const client = await signedOn("riverbend")
    const html = await (await client.get("/riverbend/desk/search")).text()

    expect(html).toContain("Member #")
    expect(html).toContain('value="Find Member"')
    // The control name is unchanged: the vendor product is the same underneath.
    expect(html).toContain('name="f1_ctl03"')
  })

  it("renames the savings product but reports the same balance", async () => {
    const client = await signedOn("riverbend")
    const html = await (await client.get("/riverbend/desk/member/12345")).text()

    expect(html).toContain("Regular Savings")
    expect(html).toContain("$4,812.65")
  })

  it("wraps content in extra markup that would break a recorded CSS path", async () => {
    const firstcity = await signedOn("firstcity")
    const riverbend = await signedOn("riverbend")

    const a = await (await firstcity.get("/firstcity/desk/search")).text()
    const b = await (await riverbend.get("/riverbend/desk/search")).text()

    const depth = (html: string) => (html.match(/<table/g) ?? []).length
    expect(depth(b)).toBeGreaterThan(depth(a))
  })
})

describe("the control endpoint", () => {
  it("is not part of the tenant namespace", async () => {
    const response = await app.request("/__control/state")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ armed: {} })
  })

  it("rejects an unknown fault mode", async () => {
    const response = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "not-a-mode" }),
    })

    expect(response.status).toBe(400)
  })
})
