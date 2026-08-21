import type { TenantVariant } from "../tenants.js"

/**
 * Period-accurate page furniture.
 *
 * Everything here is deliberately unhelpful to automation, in the specific ways
 * real back-office banking software is unhelpful:
 *
 *  - HTML 4.01 Transitional, `<font>` tags, `bgcolor`, spacer tables
 *  - form controls have neither `id`, `<label for>`, `aria-label`, nor placeholder,
 *    so they have *no accessible name at all* — the visible label lives in the
 *    adjacent table cell, and the only way to identify a field is by its relation
 *    to that cell, exactly as a human reads it
 *  - control names are generated (`f1_ctl03`), so they carry no meaning and can
 *    shift between vendor versions
 *  - no test IDs anywhere, because enterprise apps never have them
 *
 * Submit buttons *do* get an accessible name from their `value`, which is
 * realistic and gives role+name targeting something to bite on. The mix is the
 * point: some controls resolve cleanly, some need an anchor, some need pixels.
 */

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const stylesheet = (tenant: TenantVariant) => `
  body { background: #eeeeee; margin: 0; font-family: Verdana, Arial, sans-serif; font-size: 11px; }
  td { font-family: Verdana, Arial, sans-serif; font-size: 11px; }
  .hdr { background: ${tenant.accent}; color: #ffffff; }
  .bar { background: #d4d0c8; border-bottom: 1px solid #808080; }
  .fld { background: #ffffff; border: 1px solid #7f9db9; }
  .grid { background: #808080; }
  .grid td { background: #ffffff; padding: 3px 6px; }
  .grid th { background: #d4d0c8; padding: 3px 6px; text-align: left; font-size: 11px; }
  .alert { background: #ffe8e8; border: 1px solid #cc0000; color: #990000; padding: 6px; }
  .notice { background: #fffbe6; border: 1px solid #d4a017; padding: 6px; }
`

/**
 * A content-frame page. Note there is no `<main>`, no landmarks, no headings
 * hierarchy worth the name — structure is carried entirely by tables.
 */
export const legacyPage = ({
  tenant,
  title,
  body,
}: {
  tenant: TenantVariant
  title: string
  body: string
}): string => {
  const inner = `
    <table width="100%" border="0" cellpadding="6" cellspacing="0">
      <tr><td>${body}</td></tr>
    </table>`

  // Riverbend adds a wrapper table. Harmless to a person, fatal to a recorded
  // CSS path, invisible to a role+name lookup.
  const wrapped = tenant.extraTableNesting
    ? `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td>${inner}</td></tr></table>`
    : inner

  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<title>${escapeHtml(title)} - ${escapeHtml(tenant.institution)}</title>
<style type="text/css">${stylesheet(tenant)}</style>
</head>
<body bgcolor="#EEEEEE" leftmargin="0" topmargin="0" marginwidth="0" marginheight="0">
<table width="100%" border="0" cellpadding="4" cellspacing="0" class="hdr">
  <tr>
    <td><font face="Verdana" size="2"><b>${escapeHtml(tenant.institution)}</b></font></td>
    <td align="right"><font face="Verdana" size="1">CoreBank Servicing ${escapeHtml(tenant.productVersion)}</font></td>
  </tr>
</table>
<table width="100%" border="0" cellpadding="3" cellspacing="0" class="bar">
  <tr><td><font face="Verdana" size="1">${escapeHtml(title)}</font></td></tr>
</table>
${wrapped}
</body>
</html>`
}

/**
 * A labelled form row: the label is plain text in one cell, the control sits in
 * the next. The control has no accessible name of its own — this is the shape
 * that forces relational targeting.
 */
export const formRow = ({
  label,
  control,
}: {
  label: string
  control: string
}): string => `
  <tr>
    <td width="150" valign="top" nowrap><font face="Verdana" size="1"><b>${escapeHtml(label)}</b></font></td>
    <td valign="top">${control}</td>
  </tr>`

export const textInput = ({
  name,
  value = "",
  size = 20,
  maxlength,
}: {
  name: string
  value?: string
  size?: number
  maxlength?: number
}): string =>
  `<input type="text" class="fld" name="${name}" size="${size}"` +
  (maxlength ? ` maxlength="${maxlength}"` : "") +
  ` value="${escapeHtml(value)}">`

export const submitButton = ({
  name,
  label,
}: {
  name: string
  label: string
}): string =>
  `<input type="submit" name="${name}" value="${escapeHtml(label)}">`

export const alertBox = (message: string): string =>
  `<div class="alert"><font face="Verdana" size="1"><b>${escapeHtml(message)}</b></font></div>`

export const noticeBox = (message: string): string =>
  `<div class="notice"><font face="Verdana" size="1">${escapeHtml(message)}</font></div>`
