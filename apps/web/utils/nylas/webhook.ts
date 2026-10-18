import { createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";
import { secureCompare } from "@/utils/crypto-compare";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("nylas-webhook");

/**
 * Nylas wraps every notification in a CloudEvents envelope. Only the fields we
 * route on are required; the object payload varies by trigger and by provider.
 */
export const nylasWebhookSchema = z.object({
  type: z.string().min(1),
  id: z.string().optional(),
  data: z.object({
    grant_id: z.string().min(1),
    object: z
      .object({
        id: z.string().optional(),
        thread_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
  }),
});

export type NylasWebhookNotification = z.infer<typeof nylasWebhookSchema>;

/** Nylas appends these suffixes to the trigger type rather than to a field. */
const TRUNCATED_SUFFIX = ".truncated";

export function isConfiguredNylasWebhook() {
  return Boolean(env.NYLAS_WEBHOOK_SECRET);
}

/**
 * Verifies `X-Nylas-Signature`: hex HMAC-SHA256 of the **raw** request body,
 * keyed with the webhook secret. The raw bytes matter — re-serializing the
 * parsed JSON changes them and the comparison fails.
 */
export function isValidNylasSignature({
  rawBody,
  signature,
  secret,
}: {
  rawBody: string;
  signature: string | null;
  secret: string | undefined;
}): boolean {
  if (!secret || !signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return secureCompare(expected, signature.trim().toLowerCase());
}

export function parseNylasNotification(rawBody: string) {
  const parsed = nylasWebhookSchema.safeParse(safeJsonParse(rawBody));
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the trigger names a changed message. Anything ending in `.truncated`
 * dropped its body, so the object has to be re-fetched by id before it is
 * usable — the id survives truncation.
 */
export function describeNylasTrigger(type: string) {
  const truncated = type.endsWith(TRUNCATED_SUFFIX);
  const base = truncated ? type.slice(0, -TRUNCATED_SUFFIX.length) : type;

  return {
    trigger: base,
    truncated,
    affectsMessage:
      base === "message.created" ||
      base === "message.updated" ||
      base === "message.deleted",
    affectsGrant: base.startsWith("grant."),
  };
}

export function logNylasWebhookIgnored(
  reason: string,
  context: Record<string, unknown> = {},
) {
  logger.info("Ignoring Nylas webhook", { reason, ...context });
}

function safeJsonParse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
