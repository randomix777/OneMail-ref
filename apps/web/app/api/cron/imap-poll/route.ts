import { NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { hasCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import prisma from "@/utils/prisma";
import { pollImapMailbox } from "@/utils/imap/poll";
import type { Logger } from "@/utils/logger";

export const maxDuration = 300;

/** A poll logs into a real mailbox, so one request handles a small batch. */
const BATCH_SIZE = 20;

/**
 * Polls IMAP mailboxes for new mail.
 *
 * IMAP has no push, so unlike the Gmail and Graph webhooks this is the only way
 * new mail reaches the rules pipeline for those mailboxes. Runs on a schedule;
 * the cursor per mailbox is what makes it a delta rather than a full read.
 */
export const GET = withError("cron/imap-poll", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized request: api/cron/imap-poll"));
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await pollAllImapMailboxes(request.logger);
  return NextResponse.json(result);
});

async function pollAllImapMailboxes(logger: Logger) {
  const accounts = await prisma.emailAccount.findMany({
    where: {
      account: { transport: "imap", disconnectedAt: null },
    },
    select: { id: true, email: true },
    orderBy: { updatedAt: "asc" },
    take: BATCH_SIZE,
  });

  let processed = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const account of accounts) {
    try {
      const result = await pollImapMailbox({
        emailAccountId: account.id,
        logger: logger.with({ emailAccountId: account.id }),
      });

      if (result.status === "processed") processed += result.processed;
      else skipped += 1;
    } catch (error) {
      // One unreachable server must not stop the rest of the batch.
      failed.push(account.id);
      logger.error("Failed to poll an IMAP mailbox", {
        emailAccountId: account.id,
        error,
      });
    }
  }

  logger.info("Polled IMAP mailboxes", {
    accounts: accounts.length,
    processed,
    skipped,
    failed: failed.length,
  });

  return { accounts: accounts.length, processed, skipped, failed };
}
