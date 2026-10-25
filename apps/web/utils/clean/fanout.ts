import { z } from "zod";
import { cleanInboxSchema } from "@/utils/actions/clean.validation";
import { getUnhandledCount } from "@/utils/assess";
import { ONE_DAY_MS } from "@/utils/date";
import { createEmailProvider } from "@/utils/email/provider";
import { GmailLabel } from "@/utils/gmail/label";
import { brandLabels } from "@/utils/label";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { bulkPublishToQstash } from "@/utils/upstash";
import type { CleanThreadBody } from "@/app/api/clean/controller";

export const cleanFanoutSchema = cleanInboxSchema.extend({
  emailAccountId: z.string().min(1),
  jobId: z.string().min(1),
  markedDoneLabelId: z.string().min(1),
  processedLabelId: z.string().min(1),
  pageToken: z.string().optional(),
  totalEmailsProcessed: z.number().int().nonnegative().default(0),
});

export async function enqueueCleanFanout(
  body: z.infer<typeof cleanFanoutSchema>,
  logger: Logger,
) {
  await enqueueBackgroundJob({
    topic: "clean-fanout",
    body,
    logger,
    qstash: {
      path: "/api/clean/fanout",
      queueName: "clean-fanout",
      parallelism: 3,
    },
  });
}

export async function fanOutCleanPage(
  body: z.infer<typeof cleanFanoutSchema>,
  logger: Logger,
) {
  const job = await prisma.cleanupJob.findUnique({
    where: { id: body.jobId },
    select: { emailAccountId: true, createdAt: true },
  });
  if (!job || job.emailAccountId !== body.emailAccountId) {
    throw new Error("Cleanup job does not belong to the requested mailbox");
  }
  const account = await prisma.emailAccount.findUnique({
    where: { id: body.emailAccountId },
    select: { account: { select: { provider: true } } },
  });
  if (!account?.account) throw new Error("Cleanup mailbox is disconnected");
  const provider = await createEmailProvider({
    emailAccountId: body.emailAccountId,
    provider: account.account.provider,
    logger,
  });
  const remaining = body.maxEmails
    ? body.maxEmails - body.totalEmailsProcessed
    : 100;
  if (remaining <= 0) return;
  const { type } = await getUnhandledCount(provider);
  const { threads, nextPageToken } = await provider.getThreadsWithQuery({
    query: {
      ...(body.daysOld > 0
        ? {
            before: new Date(
              job.createdAt.getTime() - body.daysOld * ONE_DAY_MS,
            ),
          }
        : {}),
      labelIds:
        type === "inbox"
          ? [GmailLabel.INBOX]
          : [GmailLabel.INBOX, GmailLabel.UNREAD],
      excludeLabelNames: [brandLabels.processed.name],
    },
    pageToken: body.pageToken,
    maxResults: Math.min(remaining, 100),
  });
  const items = threads
    .filter((thread) => Boolean(thread.id))
    .slice(0, remaining)
    .map((thread) => ({
      path: "/api/clean",
      body: {
        emailAccountId: body.emailAccountId,
        threadId: thread.id,
        markedDoneLabelId: body.markedDoneLabelId,
        processedLabelId: body.processedLabelId,
        jobId: body.jobId,
        action: body.action,
        instructions: body.instructions,
        skips: body.skips,
      } satisfies CleanThreadBody,
      flowControl: { key: `ai-clean-${body.emailAccountId}`, parallelism: 3 },
    }));
  await bulkPublishToQstash({ items });
  const totalEmailsProcessed = body.totalEmailsProcessed + items.length;
  if (
    threads.length > 0 &&
    nextPageToken &&
    (!body.maxEmails || totalEmailsProcessed < body.maxEmails)
  ) {
    await enqueueCleanFanout(
      { ...body, pageToken: nextPageToken, totalEmailsProcessed },
      logger,
    );
  }
}
