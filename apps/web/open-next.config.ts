import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache is wired up yet: the app does not use ISR or
// revalidation today, so the default in-memory cache is enough and avoids
// requiring an R2/KV binding before the deployment works at all.
export default {
  ...defineCloudflareConfig(),
  // The default `build` script runs `prisma migrate deploy`, which needs a live
  // database, and the OpenNext adapters trace the build with webpack's output,
  // not Turbopack's.
  buildCommand: "cross-env CLOUDFLARE_BUILD=true pnpm run build:cf",
};
