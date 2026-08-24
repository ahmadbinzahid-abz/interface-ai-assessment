"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Either, Match } from "effect"

import type { CapabilityArtifact } from "@workspace/contracts"
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"

import { queryKeys, useApiMutation } from "@/lib/query"

/**
 * The playground: invoke a capability the way an agent would.
 *
 * The form is generated from the artifact's declared inputs rather than written,
 * which is the point of declaring them — the same declaration validates the call
 * on the server, describes it to a calling agent, and lays out this form.
 *
 * "Wait for a person" is a first-class choice rather than a hidden default. An
 * operator sitting in front of the console *is* the person a run would wait for;
 * a scheduled caller is not, and should get `Escalated` back rather than a run
 * that blocks forever on somebody who was never watching.
 */
export function RunCapabilityForm({
  artifact,
  tenant,
}: {
  readonly artifact: CapabilityArtifact
  /** Which institution to run against; the base capability when absent. */
  readonly tenant?: string
}) {
  const router = useRouter()

  const [values, setValues] = useState<Record<string, string>>({})
  const [baseUrl, setBaseUrl] = useState("http://localhost:4100")
  const [live, setLive] = useState(true)

  const start = useApiMutation(
    (client, payload: Parameters<typeof client.runs.start>[0]["payload"]) =>
      client.runs.start({ payload }),
    {
      invalidates: [queryKeys.runs, queryKeys.interventions],
      onResult: (result) => {
        if (result._tag === "Right") router.push(`/runs/${result.right.runId}`)
      },
    }
  )

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    start.mutate({
      capability: artifact.name,
      version: artifact.version,
      inputs: values,
      baseUrl,
      live,
      tenant,
    })
  }

  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle>Run this capability</CardTitle>
          <CardDescription>
            Deterministic replay — no model is consulted. The same inputs take
            the same steps in the same order, every time.
            {tenant
              ? ` Running ${tenant}'s variant, resolved through its overlay.`
              : ""}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <FieldGroup>
            {artifact.inputs.map((input) => (
              <Field key={input.name}>
                <FieldLabel htmlFor={input.name}>{input.name}</FieldLabel>
                <Input
                  id={input.name}
                  value={values[input.name] ?? ""}
                  required={input.required}
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [input.name]: event.target.value,
                    }))
                  }
                />
                <FieldDescription>
                  {input.description}
                  {input.pattern ? ` · must match ${input.pattern}` : ""}
                </FieldDescription>
              </Field>
            ))}

            <Field>
              <FieldLabel htmlFor="baseUrl">Install</FieldLabel>
              <Input
                id="baseUrl"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <FieldDescription>
                Which institution&rsquo;s install to run against. Substituted for{" "}
                <code className="font-mono">{"{{baseUrl}}"}</code>.
              </FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <input
                id="live"
                type="checkbox"
                checked={live}
                onChange={(event) => setLive(event.target.checked)}
                className="size-4 accent-primary"
              />
              <FieldLabel htmlFor="live">
                Wait for a person if it gets stuck
              </FieldLabel>
            </Field>
          </FieldGroup>
        </CardContent>

        <CardFooter className="flex flex-col items-stretch gap-3">
          {/*
            The domain answer, matched by name. `InvalidInputs` carries the
            engine's own issue list across the wire, so the form can say what is
            actually wrong instead of "invalid".
          */}
          {start.data
            ? Either.match(start.data, {
                onLeft: (error) =>
                  Match.value(error).pipe(
                    Match.tag("InvalidInputs", (invalid) => (
                      <Alert variant="destructive">
                        <AlertTitle>These inputs were rejected</AlertTitle>
                        <AlertDescription>
                          <ul>
                            {invalid.issues.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    )),
                    Match.tag("CapabilityNotFound", () => (
                      <Alert variant="destructive">
                        <AlertTitle>That capability is gone</AlertTitle>
                        <AlertDescription>
                          It was removed from <code>capabilities/</code> since
                          this page loaded.
                        </AlertDescription>
                      </Alert>
                    )),
                    Match.orElse(() => (
                      <Alert variant="destructive">
                        <AlertTitle>Could not start the run</AlertTitle>
                        <AlertDescription>
                          The orchestrator did not accept the request.
                        </AlertDescription>
                      </Alert>
                    ))
                  ),
                onRight: () => null,
              })
            : null}

          <Button type="submit" disabled={start.isPending}>
            {start.isPending ? <Spinner data-icon="inline-start" /> : null}
            {start.isPending ? "Starting…" : "Run"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}
