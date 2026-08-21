import { formatCurrency, type Account, type Member } from "../data/members.js"
import type { TenantVariant } from "../tenants.js"
import {
  alertBox,
  escapeHtml,
  formRow,
  legacyPage,
  noticeBox,
  submitButton,
  textInput,
} from "./chrome.js"

export const deskUrl = (tenant: TenantVariant, path = ""): string =>
  `/${tenant.id}/desk${path}`

// ── Sign on ──────────────────────────────────────────────────────────────

export const loginPage = (tenant: TenantVariant, error?: string): string =>
  legacyPage({
    tenant,
    title: "Sign On",
    body: `
    ${error ? alertBox(error) : ""}
    <form method="post" action="/${tenant.id}/login">
    <table border="0" cellpadding="4" cellspacing="0">
      ${formRow({ label: "Operator ID", control: textInput({ name: "f1_ctl01", size: 18 }) })}
      ${formRow({
        label: "Password",
        control: `<input type="password" class="fld" name="f1_ctl02" size="18">`,
      })}
      <tr><td></td><td>${submitButton({ name: "f1_ctl05", label: "Sign On" })}</td></tr>
    </table>
    </form>`,
  })

// ── Desk shell (a real frameset) ─────────────────────────────────────────

/**
 * A genuine `<frameset>`, not an iframe layout. Everything the automation does
 * after sign-on happens inside `contentFrame`, so the recorded target descriptors
 * have to carry a frame path — which is the point.
 */
export const deskFrameset = (tenant: TenantVariant): string =>
  `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html>
<head><title>${escapeHtml(tenant.institution)} - Servicing Desk</title></head>
<frameset cols="170,*" frameborder="1" border="1" framespacing="0">
  <frame name="navFrame" src="${deskUrl(tenant, "/nav")}" scrolling="no">
  <frame name="contentFrame" src="${deskUrl(tenant, "/search")}">
</frameset>
</html>`

export const navFrame = (tenant: TenantVariant): string =>
  legacyPage({
    tenant,
    title: "Menu",
    body: `
    <table border="0" cellpadding="3" cellspacing="0">
      <tr><td><a href="${deskUrl(tenant, "/search")}" target="contentFrame">Member Search</a></td></tr>
      <tr><td><font color="#808080">Transactions</font></td></tr>
      <tr><td><font color="#808080">Reports</font></td></tr>
    </table>`,
  })

// ── Member search ────────────────────────────────────────────────────────

export const searchPage = (
  tenant: TenantVariant,
  options: { notFoundId?: string; error?: string } = {}
): string =>
  legacyPage({
    tenant,
    title: "Member Search",
    body: `
    ${options.error ? alertBox(options.error) : ""}
    ${
      options.notFoundId
        ? alertBox(`No member found for ${options.notFoundId}.`)
        : ""
    }
    <form method="post" action="${deskUrl(tenant, "/search")}">
    <table border="0" cellpadding="4" cellspacing="0">
      ${formRow({
        label: tenant.vocabulary.memberIdLabel,
        control: textInput({ name: "f1_ctl03", size: 12, maxlength: 9 }),
      })}
      <tr><td></td><td>${submitButton({
        name: "f1_ctl09",
        label: tenant.vocabulary.searchButton,
      })}</td></tr>
    </table>
    </form>`,
  })

/**
 * A permission denial. Like "not found", this is a legitimate answer the calling
 * agent needs — not a crash.
 */
export const restrictedPage = (tenant: TenantVariant, member: Member): string =>
  legacyPage({
    tenant,
    title: "Member Search",
    body: `
    ${alertBox(
      `Account ${member.id} is restricted. Operator does not have permission to view this member.`
    )}
    <p><a href="${deskUrl(tenant, "/search")}">Return to search</a></p>`,
  })

// ── Member detail ────────────────────────────────────────────────────────

const accountRow = (tenant: TenantVariant, account: Account): string => {
  const label =
    account.kind === "Savings" ? tenant.vocabulary.savingsLabel : account.kind
  return `
    <tr>
      <td nowrap>${escapeHtml(label)}</td>
      <td nowrap>${escapeHtml(account.number)}</td>
      <td nowrap>${escapeHtml(account.opened)}</td>
      <td align="right" nowrap>${escapeHtml(formatCurrency(account.balance))}</td>
    </tr>`
}

export const memberPage = (tenant: TenantVariant, member: Member): string =>
  legacyPage({
    tenant,
    title: `Member ${member.id}`,
    body: `
    <table border="0" cellpadding="2" cellspacing="0">
      <tr>
        <td width="150"><font face="Verdana" size="1"><b>Name</b></font></td>
        <td nowrap>${escapeHtml(member.name)}</td>
      </tr>
      <tr>
        <td><font face="Verdana" size="1"><b>${escapeHtml(tenant.vocabulary.memberIdLabel)}</b></font></td>
        <td nowrap>${escapeHtml(member.id)}</td>
      </tr>
      <tr>
        <td><font face="Verdana" size="1"><b>Branch</b></font></td>
        <td nowrap>${escapeHtml(member.branch)}</td>
      </tr>
    </table>
    <br>
    <table border="0" cellpadding="1" cellspacing="1" class="grid">
      <tr><th>Account Type</th><th>Account Number</th><th>Opened</th><th>Current Balance</th></tr>
      ${[...member.accounts, ...member.subAccounts]
        .map((account) => accountRow(tenant, account))
        .join("")}
    </table>
    <br>
    <table border="0" cellpadding="0" cellspacing="0"><tr>
      <td>
        <form method="get" action="${deskUrl(tenant, `/member/${member.id}/subaccount`)}">
          ${submitButton({
            name: "f1_ctl15",
            label: tenant.vocabulary.openSubAccountButton,
          })}
        </form>
      </td>
      <td width="8"></td>
      <td>
        <form method="post" action="${deskUrl(tenant, `/member/${member.id}/close`)}">
          ${submitButton({ name: "f1_ctl22", label: "Close Account" })}
        </form>
      </td>
    </tr></table>
    <p><a href="${deskUrl(tenant, "/search")}">Return to search</a></p>`,
  })

// ── Open a sub-account ───────────────────────────────────────────────────

const productOptions = (selected: string): string =>
  ["Regular Savings", "Holiday Club", "Vacation Club"]
    .map(
      (option) =>
        `<option value="${escapeHtml(option)}"${option === selected ? " selected" : ""}>${escapeHtml(option)}</option>`
    )
    .join("")

export const subAccountFormPage = (
  tenant: TenantVariant,
  member: Member,
  options: {
    error?: string
    values?: { product?: string; deposit?: string; nickname?: string }
  } = {}
): string => {
  const values = options.values ?? {}
  return legacyPage({
    tenant,
    title: tenant.vocabulary.subAccountHeading,
    body: `
    ${options.error ? alertBox(options.error) : ""}
    <form method="post" action="${deskUrl(tenant, `/member/${member.id}/subaccount`)}">
    <table border="0" cellpadding="4" cellspacing="0">
      ${formRow({
        label: "Member",
        control: `<font face="Verdana" size="1">${escapeHtml(member.id)} - ${escapeHtml(member.name)}</font>`,
      })}
      ${formRow({
        label: "Product",
        control: `<select class="fld" name="f1_ctl11">${productOptions(values.product ?? "Regular Savings")}</select>`,
      })}
      ${formRow({
        label: "Initial Deposit",
        control: textInput({
          name: "f1_ctl12",
          size: 12,
          value: values.deposit ?? "",
        }),
      })}
      ${formRow({
        label: "Nickname",
        control: textInput({
          name: "f1_ctl13",
          size: 24,
          value: values.nickname ?? "",
        }),
      })}
      <tr><td></td><td>${submitButton({ name: "f1_ctl18", label: "Continue" })}</td></tr>
    </table>
    </form>
    <p><a href="${deskUrl(tenant, `/member/${member.id}`)}">Cancel</a></p>`,
  })
}

/** The checkpoint state for the "open a sub-account" capability. */
export const confirmationPage = (
  tenant: TenantVariant,
  member: Member,
  account: Account
): string =>
  legacyPage({
    tenant,
    title: "Confirmation",
    body: `
    ${noticeBox("Sub-account opened successfully.")}
    <br>
    <table border="0" cellpadding="2" cellspacing="0">
      <tr><td width="150"><font face="Verdana" size="1"><b>Confirmation</b></font></td><td nowrap>Sub-account opened successfully</td></tr>
      <tr><td><font face="Verdana" size="1"><b>New Account Number</b></font></td><td nowrap>${escapeHtml(account.number)}</td></tr>
      <tr><td><font face="Verdana" size="1"><b>Product</b></font></td><td nowrap>${escapeHtml(account.kind)}</td></tr>
      <tr><td><font face="Verdana" size="1"><b>Opening Balance</b></font></td><td nowrap>${escapeHtml(formatCurrency(account.balance))}</td></tr>
    </table>
    <p><a href="${deskUrl(tenant, `/member/${member.id}`)}">Back to member</a></p>`,
  })

/** Reached only if policy let an irreversible action through, which it should not. */
export const closeAccountPage = (
  tenant: TenantVariant,
  member: Member
): string =>
  legacyPage({
    tenant,
    title: "Close Account",
    body: `
    ${alertBox("This will permanently close the member's account. This cannot be undone.")}
    <form method="post" action="${deskUrl(tenant, `/member/${member.id}/close/confirm`)}">
      ${submitButton({ name: "f1_ctl24", label: "Confirm Close Account" })}
    </form>
    <p><a href="${deskUrl(tenant, `/member/${member.id}`)}">Cancel</a></p>`,
  })

// ── Runtime conditions ───────────────────────────────────────────────────

/** Unexpected interstitial. Recoverable: dismiss it and carry on. */
export const interstitialPage = (
  tenant: TenantVariant,
  continueUrl: string
): string =>
  legacyPage({
    tenant,
    title: "Notice",
    body: `
    ${noticeBox("Scheduled maintenance is planned for this weekend. Service may be briefly interrupted.")}
    <form method="get" action="${escapeHtml(continueUrl)}">
      ${submitButton({ name: "f1_ctl31", label: "Continue" })}
    </form>`,
  })

/** Session expiry. Recoverable: sign on again and retry the step. */
export const sessionExpiredPage = (tenant: TenantVariant): string =>
  legacyPage({
    tenant,
    title: "Session Expired",
    body: `
    ${alertBox("Your session has expired. Please sign on again.")}
    <p><a href="/${tenant.id}/login">Sign on</a></p>`,
  })

/** A hard failure: nothing the replay engine can do but report it clearly. */
export const serverErrorPage = (tenant: TenantVariant): string =>
  legacyPage({
    tenant,
    title: "Application Error",
    body: `
    ${alertBox("An unexpected application error has occurred. Reference CB-500-8842.")}`,
  })
