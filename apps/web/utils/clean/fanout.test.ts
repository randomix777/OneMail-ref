import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { CleanAction } from "@/generated/prisma/enums";
import { cleanFanoutSchema, fanOutCleanPage } from "./fanout";

const mocks = vi.hoisted(() => ({
  job: vi.fn(),
  account: vi.fn(),
  threads: vi.fn(),
  publish: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("@/utils/prisma", () => ({
  default: {
    cleanupJob: { findUnique: mocks.job },
    emailAccount: { findUnique: mocks.account },
  },
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: async () => ({ getThreadsWithQuery: mocks.threads }),
}));
vi.mock("@/utils/assess", () => ({
  getUnhandledCount: async () => ({ type: "inbox" }),
}));
vi.mock("@/utils/upstash", () => ({ bulkPublishToQstash: mocks.publish }));
vi.mock("@/utils/queue/dispatch", () => ({
  enqueueBackgroundJob: mocks.enqueue,
}));

describe("cleanup page fanout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.job.mockResolvedValue({
      emailAccountId: "account-1",
      createdAt: new Date("2026-10-22T00:00:00Z"),
    });
    mocks.account.mockResolvedValue({ account: { provider: "google" } });
  });

  it("carries the cursor into a bounded continuation job", async () => {
    mocks.threads.mockResolvedValue({
      threads: [{ id: "thread-1" }],
      nextPageToken: "page-3",
    });
    await fanOutCleanPage(
      cleanFanoutSchema.parse({
        emailAccountId: "account-1",
        jobId: "job-1",
        markedDoneLabelId: "done",
        processedLabelId: "processed",
        action: CleanAction.ARCHIVE,
        skips: {},
        pageToken: "page-2",
        totalEmailsProcessed: 100,
      }),
      createTestLogger(),
    );
    expect(mocks.threads).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "page-2", maxResults: 100 }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          pageToken: "page-3",
          totalEmailsProcessed: 101,
        }),
      }),
    );
  });

  it("honors the remaining limit even if the provider returns extra threads", async () => {
    mocks.threads.mockResolvedValue({
      threads: [{ id: "one" }, { id: "two" }],
      nextPageToken: "more",
    });
    await fanOutCleanPage(
      cleanFanoutSchema.parse({
        emailAccountId: "account-1",
        jobId: "job-1",
        markedDoneLabelId: "done",
        processedLabelId: "processed",
        action: CleanAction.ARCHIVE,
        skips: {},
        maxEmails: 10,
        totalEmailsProcessed: 9,
      }),
      createTestLogger(),
    );
    expect(mocks.publish).toHaveBeenCalledWith({
      items: [
        expect.objectContaining({
          body: expect.objectContaining({ threadId: "one" }),
        }),
      ],
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a job from a different mailbox before calling its provider", async () => {
    mocks.job.mockResolvedValue({ emailAccountId: "another-account" });
    await expect(
      fanOutCleanPage(
        cleanFanoutSchema.parse({
          emailAccountId: "account-1",
          jobId: "job-1",
          markedDoneLabelId: "done",
          processedLabelId: "processed",
          action: CleanAction.ARCHIVE,
          skips: {},
        }),
        createTestLogger(),
      ),
    ).rejects.toThrow("does not belong");
    expect(mocks.account).not.toHaveBeenCalled();
  });
});
