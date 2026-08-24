"use client"

import { useState } from "react"
import { Either, Match } from "effect"

import type { Step } from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Separator } from "@workspace/ui/components/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"

import {
  CapabilityStatusBadge,
  RiskBadge,
} from "@/components/common/status/outcome-badge"
import {
  ConnectionError,
  LoadingRows,
} from "@/components/common/status/query-states"
import { NotFound } from "@/components/common/status/not-found"
import { RunCapabilityForm } from "@/features/playground/components/run-capability-form"
import { useCapability, useOverlayTenants } from "../hooks/use-capabilities"

/**
 * The artifact, made readable.
 *
 * This screen is the argument for the whole design: a capability is a *contract*
 * a person can review, not a recording they have to trust. Every step shows its
 * English intent, the risk the guardrail assigned it, and what has to be true
 * afterwards for the step to count as done. Someone who was not there when it
 * was recorded can read this and say whether it is right.
 */
export function CapabilityDetail({
  name,
  version,
}: {
  readonly name: string
  readonly version: string
}) {
  /**
   * Which institution's version of this capability is on screen.
   *
   * Empty means the base artifact — the one recorded against the *product*. The
   * picker is not a filter: it re-resolves the artifact through that tenant's
   * overlay, so the steps below are the steps that would actually run there.
   */
  const [tenant, setTenant] = useState("")

  const tenants = useOverlayTenants(name, version)
  const query = useCapability(name, version, tenant || undefined)

  if (query.isPending) return <LoadingRows />
  if (query.isError)
    return <ConnectionError onRetry={() => void query.refetch()} />

  return Either.match(query.data, {
    /**
     * Every declared failure, handled by name.
     *
     * `Match.exhaustive` is the payoff: the day somebody adds an error to this
     * endpoint, this screen stops compiling until a human decides what it should
     * look like. The contract change propagates all the way to the pixels.
     */
    onLeft: (error) =>
      Match.value(error).pipe(
        Match.tag("CapabilityNotFound", (notFound) => (
          <NotFound
            title={`No capability ${notFound.name}@${notFound.version}`}
            description="Nothing in capabilities/ matches that name and version."
          />
        )),
        Match.orElse(() => (
          <ConnectionError onRetry={() => void query.refetch()} />
        ))
      ),

    onRight: (artifact) => (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-xl font-semibold">{artifact.name}</h1>
            <Badge variant="outline">v{artifact.version}</Badge>
            <CapabilityStatusBadge status={artifact.status} />
            {artifact.target.tenant ? (
              <Badge variant="secondary">
                resolved for {artifact.target.tenant}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {artifact.description}
          </p>

          {tenants.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">
                Recorded once against {artifact.target.vendorProduct}. View as:
              </span>
              <TenantChoice
                label="base product"
                active={tenant === ""}
                onSelect={() => setTenant("")}
              />
              {tenants.map((candidate) => (
                <TenantChoice
                  key={candidate}
                  label={candidate}
                  active={tenant === candidate}
                  onSelect={() => setTenant(candidate)}
                />
              ))}
            </div>
          ) : null}
        </div>

        <Tabs defaultValue="contract">
          <TabsList>
            <TabsTrigger value="contract">Contract</TabsTrigger>
            <TabsTrigger value="steps">Steps</TabsTrigger>
            <TabsTrigger value="safety">Safety &amp; provenance</TabsTrigger>
            <TabsTrigger value="run">Run it</TabsTrigger>
          </TabsList>

          <TabsContent value="contract" className="flex flex-col gap-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Inputs</CardTitle>
                <CardDescription>
                  Validated before a browser is opened, so bad input never acts.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Sensitivity</TableHead>
                      <TableHead>Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {artifact.inputs.map((input) => (
                      <TableRow key={input.name}>
                        <TableCell className="font-mono">
                          {input.name}
                          {input.required ? "" : "?"}
                        </TableCell>
                        <TableCell>{input.type}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{input.sensitivity}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {input.description}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Outputs</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Format</TableHead>
                      <TableHead>Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {artifact.outputs.map((output) => (
                      <TableRow key={output.name}>
                        <TableCell className="font-mono">
                          {output.name}
                        </TableCell>
                        <TableCell>{output.type}</TableCell>
                        <TableCell>{output.format}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {output.description}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Declared outcomes</CardTitle>
                <CardDescription>
                  Non-success answers the caller is entitled to receive. These
                  are returned as typed results, never as errors — retrying a
                  &ldquo;no such member&rdquo; would never succeed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {artifact.outcomes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None declared. This recording only ever saw the happy path,
                    so any other answer will surface as a checkpoint failure.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {artifact.outcomes.map((outcome) => (
                      <div key={outcome.tag} className="flex flex-col gap-1">
                        <Badge variant="secondary">{outcome.tag}</Badge>
                        <p className="text-sm text-muted-foreground">
                          {outcome.description}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="steps" className="pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Steps</CardTitle>
                <CardDescription>
                  Replayed in this order, every time, with no model involved.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {artifact.steps.map((step, index) => (
                  <StepRow key={step.id} step={step} index={index} />
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="safety" className="flex flex-col gap-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Policy</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <Detail label="Allowlist" value={artifact.policy.allowlistRef} />
                <Detail
                  label="Risk ceiling"
                  value={artifact.policy.maxRiskClass}
                />
                <Detail
                  label="Requires approval"
                  value={artifact.policy.requiresApproval ? "yes" : "no"}
                />
                <Separator />
                <Detail
                  label="Entry point"
                  value={artifact.target.entryPoint}
                  mono
                />
                <Detail
                  label="Vendor product"
                  value={artifact.target.vendorProduct}
                />
                <Detail
                  label="Tenant"
                  value={artifact.target.tenant ?? "none — this is a base artifact"}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Provenance</CardTitle>
                <CardDescription>
                  A digest of the model transcript, never the transcript itself —
                  transcripts contain page content, and page content contains
                  members.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <Detail
                  label="Discovered by"
                  value={artifact.provenance.discoveredBy}
                />
                <Detail
                  label="Discovered at"
                  value={artifact.provenance.discoveredAt}
                />
                <Detail label="Run" value={artifact.provenance.runId} mono />
                <Detail
                  label="Transcript digest"
                  value={artifact.provenance.transcriptDigest}
                  mono
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="run" className="pt-4">
            <RunCapabilityForm
              artifact={artifact}
              tenant={tenant || undefined}
            />
          </TabsContent>
        </Tabs>
      </div>
    ),
  })
}

function StepRow({
  step,
  index,
}: {
  readonly step: Step
  readonly index: number
}) {
  return (
    <div className="flex gap-4 border-b pb-4 last:border-0 last:pb-0">
      <div className="w-8 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">
        {index + 1}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm">{step.intent}</p>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">{step.action._tag}</Badge>
          <RiskBadge risk={step.riskClass} />
          {"target" in step.action ? (
            <span className="text-muted-foreground">
              {step.action.target.description}
            </span>
          ) : null}
        </div>

        {step.checkpoint ? (
          <p className="text-xs text-muted-foreground">
            checkpoint · {describeCondition(step.checkpoint)}
          </p>
        ) : (
          // Worth calling out rather than hiding: a step with no checkpoint is a
          // step that assumes its click worked.
          <p className="text-xs text-muted-foreground italic">
            no checkpoint — this step assumes its action took effect
          </p>
        )}
      </div>
    </div>
  )
}

const describeCondition = (condition: Step["checkpoint"]): string => {
  if (!condition) return ""

  switch (condition._tag) {
    case "textPresent":
      return `"${condition.text}" on screen`
    case "textAbsent":
      return `"${condition.text}" gone`
    case "urlMatches":
      return `url matches ${condition.pattern}`
    case "elementPresent":
      return `${condition.target.description} present`
    case "elementAbsent":
      return `${condition.target.description} gone`
    case "valueEquals":
      return `${condition.target.description} holds the value typed`
    case "httpStatusIn":
      return `http status in ${condition.statuses.join(", ")}`
    case "all":
      return condition.of.map(describeCondition).join(" and ")
    case "any":
      return condition.of.map(describeCondition).join(" or ")
    case "not":
      return `not ${describeCondition(condition.condition)}`
  }
}

/**
 * A tenant choice, as a button rather than a link.
 *
 * Switching tenants re-resolves the artifact in place; it does not navigate.
 * What the reviewer is comparing is two renderings of the same capability, and
 * making that a URL change would lose the point.
 */
function TenantChoice({
  label,
  active,
  onSelect,
}: {
  readonly label: string
  readonly active: boolean
  readonly onSelect: () => void
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      onClick={onSelect}
    >
      {label}
    </Button>
  )
}

function Detail({
  label,
  value,
  mono = false,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}) {
  return (
    <div className="flex gap-3">
      <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs break-all" : "break-words"}>
        {value}
      </span>
    </div>
  )
}
