import { after, NextResponse } from "next/server";
import { env } from "@/env";
import { withError } from "@/utils/middleware";
import { notifyMailboxChanged } from "@/utils/mailbox-push";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider } from "@/utils/email/types";
import { markMessageAsProcessing } from "@/utils/redis/message-processing";
import type { Logger } from "@/utils/logger";
import {
  describeNylasTrigger,
  isConfiguredNylasWebhook,
  isValidNylasSignature,
  logNylasWebhookIgnored,
  parseNylasNotification,
  type NylasWebhookNotification,
} from "@/utils/nylas/webhook";

export const maxDuration = 300;

/**
 * Nylas verifies the endpoint by echoing a `challenge` query parameter back as
 * the response body: exactly the value, no quotes, and no chunked encoding.
 */
export const GET = withError("nylas/webhook", async (request) => {
  const challenge = new URL(request.url).searchParams.get("challenge");

  if (!challenge) {
    return NextResponse.json({ error: "Missing challenge" }, { status: 400 });
  }

  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
});

export const POST = withError("nylas/webhook", async (request) => {
  const logger = request.logger;
  const secret = env.NYLAS_WEBHOOK_SECRET;

  // Both halves of the configuration are required before we accept anything:
  // an unverifiable endpoint must not be able to drive automation.
  if (!isConfiguredNylasWebhook()) {
    logger.error("Nylas webhook is not configured");
    return NextResponse.json(
      { error: "Nylas webhook is not configured" },
      { status: 503 },
    );
  }

  // Read the body as text so the signature is computed over the exact bytes
  // Nylas signed.
  const rawBody = await request.text();

  if (
    !isValidNylasSignature({
      rawBody,
      signature: request.headers.get("x-nylas-signature"),
      secret,
    })
  ) {
    logger.warn("Rejected Nylas webhook with an invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const notification = parseNylasNotification(rawBody);
  if (!notification) {
    logger.error("Invalid Nylas webhook payload");
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 },
    );
  }

  // Nylas retries on 5xx, so acknowledge immediately and do the work in the
  // background the way the Google and Outlook routes do.
  after(() =>
    processNylasNotification({ notification, logger }).catch((error) => {
      logger.error("Failed to process Nylas webhook", { error });
    }),
  );

  return NextResponse.json({ ok: true });
});

async function processNylasNotification({
  notification,
  logger,
}: {
  notification: NylasWebhookNotification;
  logger: Logger;
}) {
  const { data } = notification;
  const { trigger, affectsMessage, affectsGrant, truncated } =
    describeNylasTrigger(notification.type);

  const emailAccount = await getWebhookEmailAccount(
    { providerAccountId: data.grant_id },
    logger,
  );

  if (!emailAccount) {
    // Nylas keeps sending for a while after an account is removed.
    logNylasWebhookIgnored("unknown grant", { trigger });
    return;
  }

  // The local mail engine refreshes off this signal, so send it before any
  // gate that might skip rule execution.
  await notifyMailboxChanged({ emailAccountId: emailAccount.id, logger });

  if (affectsGrant) {
    // A revoked or expired grant is a reconnect prompt, not a mail event.
    logger.info("Nylas grant state changed", {
      trigger,
      emailAccountId: emailAccount.id,
    });
  }

  if (!affectsMessage) return;

  const validation = await validateWebhookAccount(emailAccount, logger);
  if (!validation.success) return;
  const { data: validated } = validation;

  const messageId = data.object?.id;
  if (!messageId) {
    logger.info("Nylas notification carried no message id", { trigger });
    return;
  }

  const isFree = await markMessageAsProcessing({
    userEmail: emailAccount.email,
    messageId,
  });
  if (!isFree) {
    logger.info("Skipping. Message already being processed.");
    return;
  }

  const provider = await createEmailProvider({
    emailAccountId: emailAccount.id,
    provider: emailAccount.account?.provider,
    logger,
  });

  const threadId = await resolveThreadId({
    truncated,
    messageId,
    payloadThreadId: data.object?.thread_id,
    provider,
    logger,
  });

  await processHistoryItem(
    { messageId, threadId },
    {
      provider,
      isNewMessage: trigger === "message.created",
      emailAccount: validated.emailAccount,
      hasAutomationRules: validated.hasAutomationRules,
      hasAiAccess: validated.hasAiAccess,
      rules: validated.emailAccount.rules,
      logger,
    },
  );
}

/**
 * Which thread the changed message belongs to.
 *
 * A truncated notification dropped its object body, so the thread id is not in
 * the payload and has to come from the provider. A deleted message is already
 * gone by the time this runs, which is why the payload id stays the fallback
 * rather than being an error.
 */
async function resolveThreadId({
  truncated,
  messageId,
  payloadThreadId,
  provider,
  logger,
}: {
  truncated: boolean;
  messageId: string;
  payloadThreadId: string | undefined;
  provider: EmailProvider;
  logger: Logger;
}) {
  if (payloadThreadId) return payloadThreadId;
  if (!truncated) return messageId;

  try {
    const message = await provider.getMessage(messageId);
    return message.threadId || messageId;
  } catch (error) {
    logger.warn("Could not read the thread of a truncated Nylas notification", {
      error,
      messageId,
    });
    return messageId;
  }
}
