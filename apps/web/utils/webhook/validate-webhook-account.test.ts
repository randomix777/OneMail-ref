import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cleanupWebhookAccountOnRateLimitSkip,
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "./validate-webhook-account";
import type { ValidatedWebhookAccountData } from "./validate-webhook-account";
import { DraftReplyConfidence, PremiumTier } from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";
import { createTestLogger } from "@/__tests__/helpers";

const logger = createTestLogger();

vi.mock("@/utils/premium");
vi.mock("@/app/api/watch/controller");
vi.mock("@/utils/email/provider");
vi.mock("@/utils/email/watch-manager");
vi.mock("@/utils/prisma");
vi.mock("@/utils/email-account-client", () => ({
  getGmailClientForEmail: vi.fn(),
  getOutlookClientForEmail: vi.fn(),
}));
vi.mock("@/utils/log-error-with-dedupe", () => ({
  logErrorWithDedupe: vi.fn(),
}));

import { hasAiAccess, isPremiumRecord } from "@/utils/premium";
import { unwatchEmails } from "@/utils/email/watch-manager";
import { createEmailProvider } from "@/utils/email/provider";
import { logErrorWithDedupe } from "@/utils/log-error-with-dedupe";
import { getGmailClientForEmail } from "@/utils/email-account-client";

describe("validateWebhookAccount", () => {
  const mockEmailProvider = { type: "google" as const };

  beforeEach(() => {
    vi.clearAllMocks();
    // The assistant is open to every account, so the automock says so too.
    vi.mocked(hasAiAccess).mockReturnValue(true);
    vi.mocked(createEmailProvider).mockResolvedValue(mockEmailProvider as any);
    vi.mocked(unwatchEmails).mockResolvedValue(undefined);
    vi.mocked(getGmailClientForEmail).mockResolvedValue({} as any);
  });

  function createMockEmailAccount(
    overrides: Partial<NonNullable<ValidatedWebhookAccountData>> = {},
  ): NonNullable<ValidatedWebhookAccountData> {
    return {
      id: "account-id",
      email: "user@test.com",
      userId: "user-id",
      about: "Test account",
      lastSyncedHistoryId: null,
      autoCategorizeSenders: false,
      watchEmailsSubscriptionId: "subscription-id",
      multiRuleSelectionEnabled: false,
      timezone: null,
      calendarBookingLink: null,
      watchEmailsSubscriptionHistory: [],
      account: {
        provider: "google",
        // These fixtures describe a token-based mailbox; without saying so the
        // account falls back to the family default and looks like a Nylas one.
        transport: "oauth",
        providerAccountId: null,
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: new Date(),
        disconnectedAt: null,
      },
      rules: [
        {
          id: "rule-id",
          name: "Test Rule",
          instructions: "Test instructions",
          actions: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          enabled: true,
          runOnThreads: false,
          groupId: null,
          from: null,
          to: null,
          subject: null,
          body: null,
          categoryFilterType: null,
          conditionalOperator: "AND",
          automate: true,
          emailAccountId: "account-id",
          systemType: null,
          promptText: null,
        },
      ],
      user: {
        aiProvider: null,
        aiModel: null,
        aiApiKey: null,
        premium: {
          appleExpiresAt: null,
          appleRevokedAt: null,
          lemonSqueezyRenewsAt: new Date(Date.now() + 86_400_000), // Tomorrow
          stripeSubscriptionStatus: "active",
          tier: PremiumTier.PRO_MONTHLY,
        },
      },
      ...overrides,
      draftReplyConfidence:
        overrides.draftReplyConfidence ?? DraftReplyConfidence.ALL_EMAILS,
      filingEnabled: overrides.filingEnabled ?? false,
      filingPrompt: overrides.filingPrompt ?? null,
      filingConfirmationSendEmail:
        overrides.filingConfirmationSendEmail ?? true,
    };
  }

  describe("when emailAccount is null", () => {
    it("should return failure with error logged", async () => {
      const result = await validateWebhookAccount(null, logger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(await result.response.json()).toEqual({ ok: true });
      }
    });
  });

  describe("cleanupWebhookAccountOnRateLimitSkip", () => {
    it("keeps watching an account that is not subscribed", async () => {
      const emailAccount = createMockEmailAccount({
        user: {
          aiProvider: null,
          aiModel: null,
          aiApiKey: null,
          premium: null,
        },
      });

      vi.mocked(isPremiumRecord).mockReturnValue(false);

      await cleanupWebhookAccountOnRateLimitSkip(emailAccount, logger);

      expect(unwatchEmails).not.toHaveBeenCalled();
    });

    it("unwatches an account whose provider connection is gone", async () => {
      const emailAccount = createMockEmailAccount({
        account: {
          provider: "google",
          transport: "oauth",
          providerAccountId: null,
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_at: new Date(),
          disconnectedAt: new Date(),
        },
      });

      await cleanupWebhookAccountOnRateLimitSkip(emailAccount, logger);

      expect(getGmailClientForEmail).toHaveBeenCalledWith({
        emailAccountId: "account-id",
        logger,
      });
      expect(unwatchEmails).toHaveBeenCalledWith(
        expect.objectContaining({
          emailAccountId: "account-id",
          subscriptionId: "subscription-id",
          provider: expect.objectContaining({ name: "google" }),
        }),
      );
    });
  });

  describe("when account is disconnected", () => {
    it("should return failure with 200 OK early", async () => {
      const emailAccount = createMockEmailAccount({
        account: {
          provider: "google",
          transport: "oauth",
          providerAccountId: null,
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_at: new Date(),
          disconnectedAt: new Date(),
        },
      });

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(await result.response.json()).toEqual({ ok: true });
      }
    });
  });

  describe("when the account is not subscribed", () => {
    it("keeps the mailbox watched and validates the account", async () => {
      const emailAccount = createMockEmailAccount({
        user: {
          aiProvider: null,
          aiModel: null,
          aiApiKey: null,
          premium: null,
        },
      });

      vi.mocked(isPremiumRecord).mockReturnValue(false);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(true);
      expect(unwatchEmails).not.toHaveBeenCalled();
    });
  });

  describe("when the account has no subscription and no rules", () => {
    it("returns failure without unwatching the mailbox", async () => {
      const emailAccount = createMockEmailAccount({
        user: {
          aiProvider: null,
          aiModel: null,
          aiApiKey: null,
          premium: null,
        },
        rules: [],
      });

      vi.mocked(isPremiumRecord).mockReturnValue(false);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(false);
      expect(unwatchEmails).not.toHaveBeenCalled();
    });
  });

  describe("when account has no automation rules", () => {
    it("should return failure", async () => {
      const emailAccount = createMockEmailAccount({
        rules: [],
      });

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(false);
      expect(unwatchEmails).not.toHaveBeenCalled();
      if (!result.success) {
        expect(await result.response.json()).toEqual({ ok: true });
      }
    });

    it("should succeed when filing is enabled with a prompt but no rules", async () => {
      const emailAccount = createMockEmailAccount({
        rules: [],
        filingEnabled: true,
        filingPrompt: "File newsletters under Newsletters",
      });

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hasAutomationRules).toBe(false);
        expect(result.data.emailAccount).toEqual(emailAccount);
      }
    });
  });

  describe("when the mailbox authenticates on a non-OAuth transport", () => {
    it("accepts a Nylas mailbox that has a grant id but no tokens", async () => {
      // Nylas holds the tokens and the linking callback stores null for both.
      // Requiring them here skipped every message that transport delivered.
      const emailAccount = createMockEmailAccount({
        account: {
          provider: "google",
          transport: "nylas",
          providerAccountId: "grant-1",
          access_token: null,
          refresh_token: null,
          expires_at: null,
          disconnectedAt: null,
        },
      });

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(true);
    });

    it("accepts an IMAP mailbox whose credential is active", async () => {
      const emailAccount = createMockEmailAccount({
        account: {
          provider: "fastmail",
          transport: "imap",
          providerAccountId: null,
          access_token: null,
          refresh_token: null,
          expires_at: null,
          disconnectedAt: null,
        },
      });
      emailAccount.mailboxCredential = { active: true };

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(true);
    });

    it("rejects an IMAP mailbox whose credential was deactivated", async () => {
      const emailAccount = createMockEmailAccount({
        account: {
          provider: "fastmail",
          transport: "imap",
          providerAccountId: null,
          access_token: null,
          refresh_token: null,
          expires_at: null,
          disconnectedAt: null,
        },
      });
      emailAccount.mailboxCredential = { active: false };

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(false);
    });
  });

  describe("when access_token is missing", () => {
    it("should return failure with error logged", async () => {
      const emailAccount = createMockEmailAccount({
        account: {
          provider: "google",
          transport: "oauth",
          providerAccountId: null,
          access_token: null,
          refresh_token: "refresh-token",
          expires_at: new Date(),
          disconnectedAt: null,
        },
      });

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(await result.response.json()).toEqual({ ok: true });
      }
    });
  });

  describe("when refresh_token is missing", () => {
    it("should return failure with error logged", async () => {
      const emailAccount = createMockEmailAccount({
        account: {
          provider: "google",
          transport: "oauth",
          providerAccountId: null,
          access_token: "access-token",
          refresh_token: null,
          expires_at: new Date(),
          disconnectedAt: null,
        },
      });

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(await result.response.json()).toEqual({ ok: true });
      }
    });
  });

  describe("when account is null", () => {
    it("should return failure with error logged", async () => {
      const emailAccount = {
        ...createMockEmailAccount(),
        account: null,
      } as any as ValidatedWebhookAccountData;

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(await result.response.json()).toEqual({ ok: true });
      }
    });
  });

  describe("when all validation passes", () => {
    it("should return success with validated data", async () => {
      const emailAccount = createMockEmailAccount();

      vi.mocked(isPremiumRecord).mockReturnValue(true);
      vi.mocked(hasAiAccess).mockReturnValue(true);

      const result = await validateWebhookAccount(emailAccount, logger);

      expect(result.success).toBe(true);
      expect(unwatchEmails).not.toHaveBeenCalled();

      if (result.success) {
        expect(result.data).toEqual({
          emailAccount,
          hasAutomationRules: true,
          hasAiAccess: true,
        });
      }
    });
  });
});

describe("getWebhookEmailAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a deduped account-not-found error for email lookup misses", async () => {
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(null);

    await getWebhookEmailAccount({ email: "user@example.com" }, logger);

    expect(logErrorWithDedupe).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Account not found",
        dedupeKeyParts: expect.objectContaining({
          lookupType: "email",
          email: "user@example.com",
        }),
      }),
    );
  });

  it("logs a deduped account-not-found error for subscription lookup misses", async () => {
    vi.mocked(prisma.emailAccount.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);

    await getWebhookEmailAccount(
      { watchEmailsSubscriptionId: "sub-123" },
      logger,
    );

    expect(logErrorWithDedupe).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Account not found",
        dedupeKeyParts: expect.objectContaining({
          lookupType: "subscription",
          watchEmailsSubscriptionId: "sub-123",
        }),
      }),
    );
  });

  it("resolves the account when the subscription id only exists in watch history", async () => {
    const historicalAccount = {
      id: "resolved-account-id",
      email: "user@example.com",
      watchEmailsSubscriptionId: "new-subscription-id",
    };
    const historicalSubscriptionId = `old-sub-id' OR 1=1 --`;

    vi.mocked(prisma.emailAccount.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(historicalAccount as any);

    const result = await getWebhookEmailAccount(
      { watchEmailsSubscriptionId: historicalSubscriptionId },
      logger,
    );

    expect(result).toEqual(historicalAccount);
    expect(prisma.emailAccount.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        watchEmailsSubscriptionHistory: {
          array_contains: [{ subscriptionId: historicalSubscriptionId }],
        },
      },
      select: expect.any(Object),
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(logErrorWithDedupe).not.toHaveBeenCalled();
  });
});
