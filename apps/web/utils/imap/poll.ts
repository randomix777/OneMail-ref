import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { createEmailProvider } from "@/utils/email/provider";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import prisma from "@/utils/prisma";

/** One poll asks for at most this many new messages. */
const POLL_PAGE_SIZE = 25;

export type PollResult = {
  status: "processed" | "skipped";
  /** New messages the rules pipeline was asked to look at. */
  processed: number;
};

/**
 * Polls one IMAP mailbox and runs the rules pipeline on what arrived.
 *
 * This is the IMAP equivalent of Gmail's history and Graph's subscriptions: a
 * plain IMAP server has no push, so new mail arrives only when we ask. The cursor
 * carries UIDVALIDITY, so a renumbered mailbox restarts from a full read instead
 * of reporting an empty delta forever.
 *
 * The account goes through the same validation a webhook does, so a mailbox that
 * is disconnected, unpriced or out of AI credit cannot be polled into work a
 * webhook would have refused.
 */
export async function pollImapMailbox({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}): Promise<PollResult> {
  const account = await getWebhookEmailAccount({ id: emailAccountId }, logger);
  const validation = await validateWebhookAccount(account, logger);
  if (!validation.success) return { status: "skipped", processed: 0 };

  const { emailAccount, hasAutomationRules, hasAiAccess } = validation.data;
  const provider = await createEmailProvider({
    emailAccountId,
    provider: emailAccount.account?.provider,
    logger,
  });

  const { messages, cursor } = await readNewMessages({
    provider,
    cursor: emailAccount.imapSyncCursor,
    logger,
  });

  for (const message of messages) {
    await processHistoryItem(
      { messageId: message.id, threadId: message.threadId, message },
      {
        provider,
        emailAccount,
        hasAutomationRules,
        hasAiAccess,
        rules: emailAccount.rules,
        logger,
      },
    );
  }

  // Persisted after processing: a failure part-way through leaves the cursor where
  // it was so the same messages are retried rather than skipped.
  await prisma.emailAccount.update({
    where: { id: emailAccountId },
    data: { imapSyncCursor: cursor },
  });

  logger.info("Polled an IMAP mailbox", { processed: messages.length });

  return { status: "processed", processed: messages.length };
}

async function readNewMessages({
  provider,
  cursor,
  logger,
}: {
  provider: EmailProvider;
  cursor: string | null;
  logger: Logger;
}) {
  const page = await provider.getMailboxSyncPage({
    folderId: "INBOX",
    cursor: cursor ?? undefined,
    limit: POLL_PAGE_SIZE,
  });

  if (page.reset) {
    // The cursor could not be trusted (new UIDVALIDITY, or a different mailbox),
    // so this page is a full read and the old cursor is worthless.
    logger.info("IMAP cursor reset; reading the mailbox from the start");
  }

  return {
    messages: page.upsertedMessages.slice(0, POLL_PAGE_SIZE),
    cursor: page.cursor,
  };
}
