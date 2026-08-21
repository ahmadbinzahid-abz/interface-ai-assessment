import { serve } from "@hono/node-server"

import { createApp } from "./app.js"
import { config } from "./config.js"
import { listTenants } from "./tenants.js"

serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  const base = `http://localhost:${info.port}`
  console.log(`CoreBank Servicing (stand-in) listening on ${base}`)
  for (const tenant of listTenants()) {
    console.log(`  ${tenant.institution.padEnd(26)} ${base}/${tenant.id}/login`)
  }
})
