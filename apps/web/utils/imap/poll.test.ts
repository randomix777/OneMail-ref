import { beforeEach, describe, expect, it, vi } from "vitest";
import { pollImapMailbox } from "@/utils/imap/poll";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");
vi.mock("@/utils/webhook/validate-webhook-account");
vi.mock("@/utils/email/provider");
vi.mock("@/utils/webhook/process-history-item");

const { getWebhookEmailAccount, validateWebhookAccount } = await import(
  "@/utils/webhook/validate-webhook-account"
);
const { createEmailProvider } = await import("@/utils/email/provider");
const { processHistoryItem } = await import(
  "@/utils/webhook/process-history-item"
);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  with: vi.fn(),
} as never;

function emailAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "email-account-1",
    email: "owner@example.com",
    imapSyncCursor: null,
    account: { provider: "fastmail" },
    rules: [],
    ...overrides,
  };
}

function providerPage({
  messages = [
    { id: "INBOX:1", threadId: "m1", subject: "One" },
    { id: "INBOX:2", threadId: "m2", subject: "Two" },
  ],
  cursor = "cursor-2",
  reset = false,
} = {}) {
  return {
    cursor,
    reset,
    deletedMessageIds: [],
    hasMore: false,
    upsertedMessages: messages,
  };
}

const provider = {
  getMailboxSyncPage: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount() as never);
  // Echo the loaded row, the way the real validator returns the account it was
  // given; otherwise these two stubs can disagree about which account is polled.
  vi.mocked(validateWebhookAccount).mockImplementation((async (account) =>
    account
      ? {
          success: true,
          data: {
            emailAccount: account,
            hasAutomationRules: true,
            hasAiAccess: true,
          },
        }
      : { success: false, response: new Response(null) }) as never);
  vi.mocked(createEmailProvider).mockResolvedValue(provider as never);
  provider.getMailboxSyncPage.mockResolvedValue(providerPage());
  vi.mocked(processHistoryItem).mockResolvedValue(undefined as never);
  prisma.emailAccount.update.mockResolvedValue(undefined as never);
});

describe("pollImapMailbox", () => {
  it("runs the rules pipeline for each new message and advances the cursor", async () => {
    const result = await pollImapMailbox({
      emailAccountId: "email-account-1",
      logger,
    });

    expect(result).toEqual({ status: "processed", processed: 2 });
    expect(processHistoryItem).toHaveBeenCalledTimes(2);
    expect(processHistoryItem).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "INBOX:1", threadId: "m1" }),
      expect.objectContaining({ hasAutomationRules: true, hasAiAccess: true }),
    );
    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "email-account-1" },
      data: { imapSyncCursor: "cursor-2" },
    });
  });

  it("passes the stored cursor so the mailbox is read as a delta", async () => {
    vi.mocked(getWebhookEmailAccount).mockResolvedValue(
      emailAccount({ imapSyncCursor: "cursor-1" }) as never,
    );

    await pollImapMailbox({ emailAccountId: "email-account-1", logger });

    expect(provider.getMailboxSyncPage).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: "INBOX", cursor: "cursor-1" }),
    );
  });

  it("advances the cursor even when nothing new arrived", async () => {
    // Otherwise a quiet mailbox keeps asking for a page it has already read.
    provider.getMailboxSyncPage.mockResolvedValue(
      providerPage({ messages: [] }),
    );

    const result = await pollImapMailbox({
      emailAccountId: "email-account-1",
      logger,
    });

    expect(result).toEqual({ status: "processed", processed: 0 });
    expect(processHistoryItem).not.toHaveBeenCalled();
    expect(prisma.emailAccount.update).toHaveBeenCalled();
  });

  it("leaves the cursor alone when processing fails part-way through", async () => {
    // The messages that did not run would otherwise be skipped for good.
    vi.mocked(processHistoryItem).mockRejectedValueOnce(new Error("boom"));

    await expect(
      pollImapMailbox({ emailAccountId: "email-account-1", logger }),
    ).rejects.toThrow("boom");

    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("does nothing when the account fails validation", async () => {
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: false,
      response: new Response(null),
    } as never);

    const result = await pollImapMailbox({
      emailAccountId: "email-account-1",
      logger,
    });

    expect(result).toEqual({ status: "skipped", processed: 0 });
    expect(createEmailProvider).not.toHaveBeenCalled();
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("skips an account that no longer exists", async () => {
    vi.mocked(getWebhookEmailAccount).mockResolvedValue(null as never);

    const result = await pollImapMailbox({
      emailAccountId: "email-account-1",
      logger,
    });

    expect(result).toEqual({ status: "skipped", processed: 0 });
    expect(createEmailProvider).not.toHaveBeenCalled();
  });
});
