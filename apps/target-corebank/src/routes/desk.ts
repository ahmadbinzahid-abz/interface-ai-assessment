import type { Context, Hono } from "hono"

import { config } from "../config.js"
import {
  findMember,
  nextSubAccountNumber,
  type Account,
  type Member,
} from "../data/members.js"
import { tenantPath, type AppEnv } from "../env.js"
import { consumeFault } from "../faults.js"
import {
  closeAccountPage,
  confirmationPage,
  deskFrameset,
  deskUrl,
  memberPage,
  navFrame,
  restrictedPage,
  searchPage,
  subAccountFormPage,
} from "../views/pages.js"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Server-side validation of the sub-account form. Returns a message for the
 * first problem, mirroring how these applications report one error at a time.
 */
const validateSubAccount = (
  deposit: string,
  nickname: string
): string | undefined => {
  if (deposit.trim() === "") return "Initial Deposit is required."

  const amount = Number(deposit.replace(/[$,]/g, ""))
  if (!Number.isFinite(amount)) return "Initial Deposit must be a number."
  if (amount < 25) return "Initial Deposit must be at least $25.00."
  if (nickname.length > 24) return "Nickname must be 24 characters or fewer."

  return undefined
}

export const registerDeskRoutes = (app: Hono<AppEnv>): void => {
  app.get(tenantPath("/desk"), (c) => c.html(deskFrameset(c.get("tenant"))))

  app.get(tenantPath("/desk/nav"), (c) => c.html(navFrame(c.get("tenant"))))

  app.get(tenantPath("/desk/search"), (c) =>
    c.html(searchPage(c.get("tenant")))
  )

  app.post(tenantPath("/desk/search"), async (c) => {
    const tenant = c.get("tenant")

    // Transient slowness: recoverable by waiting, not by retrying blindly.
    if (consumeFault("slow")) await delay(config.slowResponseMs)

    const form = await c.req.formData()
    const memberId = String(form.get("f1_ctl03") ?? "").trim()

    if (memberId === "") {
      return c.html(
        searchPage(tenant, {
          error: `${tenant.vocabulary.memberIdLabel} is required.`,
        }),
        400
      )
    }

    const member = findMember(memberId)

    // "No such member" is an answer, not a failure.
    if (!member)
      return c.html(searchPage(tenant, { notFoundId: memberId }), 404)

    // So is a permission denial.
    if (member.status === "restricted")
      return c.html(restrictedPage(tenant, member), 403)

    return c.redirect(deskUrl(tenant, `/member/${member.id}`), 303)
  })

  /** Resolves the member named in the path, or renders the not-found result. */
  const withMember = (
    c: Context<AppEnv>,
    handle: (member: Member) => Response
  ): Response => {
    const tenant = c.get("tenant")
    const memberId = c.req.param("id") ?? ""
    const member = findMember(memberId)

    if (!member)
      return c.html(searchPage(tenant, { notFoundId: memberId }), 404)
    if (member.status === "restricted")
      return c.html(restrictedPage(tenant, member), 403)

    return handle(member)
  }

  app.get(tenantPath("/desk/member/:id"), (c) =>
    withMember(c, (member) => c.html(memberPage(c.get("tenant"), member)))
  )

  app.get(tenantPath("/desk/member/:id/subaccount"), (c) =>
    withMember(c, (member) =>
      c.html(subAccountFormPage(c.get("tenant"), member))
    )
  )

  app.post(tenantPath("/desk/member/:id/subaccount"), async (c) => {
    const form = await c.req.formData()
    const product = String(form.get("f1_ctl11") ?? "Regular Savings")
    const deposit = String(form.get("f1_ctl12") ?? "")
    const nickname = String(form.get("f1_ctl13") ?? "")

    return withMember(c, (member) => {
      const tenant = c.get("tenant")

      // An injected server-side rejection: the input looked fine to the client
      // but the core declined it. A business outcome, not a crash.
      const injected = consumeFault("validation")
        ? "Product is not available for this member's branch."
        : undefined

      const problem = injected ?? validateSubAccount(deposit, nickname)

      if (problem) {
        return c.html(
          subAccountFormPage(tenant, member, {
            error: problem,
            values: { product, deposit, nickname },
          }),
          422
        )
      }

      const account: Account = {
        kind: "Savings",
        number: nextSubAccountNumber(member),
        balance: Number(deposit.replace(/[$,]/g, "")),
        opened: new Date().toISOString().slice(0, 10),
      }
      member.subAccounts.push(account)

      return c.html(confirmationPage(tenant, member, account))
    })
  })

  // Irreversible. Present so the policy engine has something real to refuse;
  // reaching this page at all means a guardrail failed.
  app.post(tenantPath("/desk/member/:id/close"), (c) =>
    withMember(c, (member) => c.html(closeAccountPage(c.get("tenant"), member)))
  )
}
