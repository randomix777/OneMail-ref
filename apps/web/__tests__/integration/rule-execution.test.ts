/**
 * Integration test: rule execution
 *
 * Tests the executeAct function — the core of rule execution that applies
 * labels, archives, marks read, and creates drafts — against the Nylas
 * transport. AI matching is bypassed; we feed pre-built action items directly
 * and verify that provider state changes persist.
 *
 * Usage:
 *   pnpm test-integration rule-execution
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import {
  createNylasTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
} from "./helpers";
import { executeAct } from "@/utils/ai/choose-rule/execute";
import { ActionType, ExecutedRuleStatus } from "@/generated/prisma/enums";
import { createTestLogger } from "@/__tests__/helpers";

// Mock Prisma — executeAct updates executedRule status
const mockExecutedRuleUpdate = vi.fn().mockResolvedValue({});
const mockActionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
vi.mock("@/utils/prisma", () => ({
  default: {
    executedRule: {
      update: (...args: unknown[]) => mockExecutedRuleUpdate(...args),
    },
    action: {
      updateMany: (...args: unknown[]) => mockActionUpdateMany(...args),
    },
  },
}));

// Mock Tinybird — archiveThread publishes analytics
vi.mock("@inboxzero/tinybird", () => ({
  publishArchive: vi.fn().mockResolvedValue(undefined),
}));

// Mock draft management — updateExecutedActionWithDraftId is called if draft actions exist
vi.mock("@/utils/ai/choose-rule/draft-management", () => ({
  updateExecutedActionWithDraftId: vi.fn().mockResolvedValue(undefined),
  handlePreviousDraftDeletion: vi.fn().mockResolvedValue(undefined),
}));

// Mock error deduplication
vi.mock("@/utils/log-error-with-dedupe", () => ({
  logErrorWithDedupe: vi.fn(),
}));

// Mock encryption — imported transitively via auth
vi.mock("@/utils/encryption", () => ({
  encrypt: vi.fn((s: string) => s),
  decrypt: vi.fn((s: string) => s),
}));

// `@/env` validates on first evaluation and the Nylas transport reads its URI
// and key from it, so they have to be in place before the imports above resolve.
// Guarded so a run that skips these tests never touches the environment.
vi.hoisted(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    process.env.NYLAS_API_KEY = "test-nylas-api-key";
    process.env.NYLAS_API_URI = "https://nylas.test";
  }
});

afterAll(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    delete process.env.NYLAS_API_KEY;
    delete process.env.NYLAS_API_URI;
  }
});

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const TEST_EMAIL = "rules-test@example.com";

const SEED_MESSAGES: NylasSeedMessage[] = [
  {
    id: "msg_to_label",
    threadId: "thread_to_label",
    fromEmail: "ceo@company.com",
    subject: "Quarterly review",
    body: "Please review the Q1 numbers.",
    folders: ["INBOX", "UNREAD"],
    unread: true,
    receivedAt: new Date(1_711_900_000_000),
  },
  {
    id: "msg_to_archive",
    threadId: "thread_to_archive",
    fromEmail: "newsletter@updates.com",
    subject: "Weekly digest",
    body: "Here is your weekly digest.",
    folders: ["INBOX", "UNREAD"],
    unread: true,
    receivedAt: new Date(1_711_900_060_000),
  },
  {
    id: "msg_to_draft",
    threadId: "thread_to_draft",
    fromEmail: "partner@partner.io",
    subject: "Meeting follow-up",
    body: "Thanks for the meeting yesterday.",
    folders: ["INBOX", "UNREAD"],
    unread: true,
    receivedAt: new Date(1_711_900_120_000),
  },
];

const THREAD_IDS = Object.fromEntries(
  SEED_MESSAGES.map((seed) => [seed.id, seed.threadId ?? seed.id]),
);

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Rule execution (executeAct)",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;
    let provider: NylasTestHarness["provider"];
    const emailAccount = {
      email: TEST_EMAIL,
      id: "test-account-id",
      userId: "test-user-id",
    };

    beforeAll(async () => {
      harness = await createNylasTestHarness({ messages: SEED_MESSAGES });
      provider = harness.provider;
    });

    afterAll(() => {
      harness?.restoreFetch();
    });

    function buildExecutedRule(
      messageId: string,
      actionItems: Array<{
        id: string;
        type: ActionType;
        label?: string | null;
        labelId?: string | null;
        content?: string | null;
        subject?: string | null;
        to?: string | null;
        cc?: string | null;
        bcc?: string | null;
      }>,
    ) {
      return {
        id: `exec-${messageId}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        messageId,
        threadId: THREAD_IDS[messageId],
        automated: true,
        reason: "test",
        status: ExecutedRuleStatus.APPLYING,
        ruleId: "test-rule-1",
        emailAccountId: "test-account-id",
        // Fields required by Prisma type
        draftContextMetadata: null,
        draftModelName: null,
        draftModelProvider: null,
        draftPipelineVersion: null,
        matchReasons: null,
        actionItems: actionItems.map((item) => ({
          ...item,
          label: item.label ?? null,
          labelId: item.labelId ?? null,
          content: item.content ?? null,
          subject: item.subject ?? null,
          to: item.to ?? null,
          cc: item.cc ?? null,
          bcc: item.bcc ?? null,
          url: null,
          folderName: null,
          folderId: null,
          staticAttachments: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          executedRuleId: `exec-${messageId}`,
        })),
      };
    }

    function buildParsedMessage(seed: NylasSeedMessage) {
      const receivedAt = seed.receivedAt ?? new Date();

      return {
        id: seed.id,
        threadId: seed.threadId ?? seed.id,
        headers: {
          from: seed.fromEmail ?? "ada@example.com",
          to: seed.toEmail ?? "owner@example.com",
          subject: seed.subject ?? "",
          date: receivedAt.toISOString(),
          "message-id": `<${seed.id}@test>`,
        },
        textPlain: seed.body ?? "",
        textHtml: "",
        snippet: (seed.body ?? "").slice(0, 50),
        labelIds: [
          ...(seed.folders ?? ["INBOX"]),
          ...(seed.unread ? ["UNREAD"] : []),
        ],
        internalDate: String(receivedAt.getTime()),
        historyId: "1",
        subject: seed.subject ?? "",
        date: receivedAt.toISOString(),
        inline: [],
        attachments: [],
        rawRecipients: [],
      };
    }

    function foldersOf(messageId: string) {
      return harness.mailbox.find((message) => message.id === messageId)
        ?.folders;
    }

    test("LABEL action: creates label and applies it to message", async () => {
      mockExecutedRuleUpdate.mockClear();

      const executedRule = buildExecutedRule("msg_to_label", [
        { id: "action-1", type: ActionType.LABEL, label: "CEO/Important" },
      ]);

      const message = buildParsedMessage(SEED_MESSAGES[0]);

      await executeAct({
        client: provider,
        executedRule,
        message,
        emailAccount,
        logger: createTestLogger(),
      });

      // Verify Prisma was called to mark rule as APPLIED
      expect(mockExecutedRuleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: executedRule.id },
          data: { status: ExecutedRuleStatus.APPLIED },
        }),
      );

      // Verify the label exists at the provider
      const ceoLabel = harness.labels.find(
        (label) => label.name === "CEO/Important",
      );
      expect(ceoLabel).toBeDefined();

      // Verify it was applied to the message
      expect(foldersOf("msg_to_label")).toContain(ceoLabel?.id);
    });

    test("ARCHIVE action: removes INBOX label from thread", async () => {
      mockExecutedRuleUpdate.mockClear();

      const executedRule = buildExecutedRule("msg_to_archive", [
        { id: "action-2", type: ActionType.ARCHIVE },
      ]);

      const message = buildParsedMessage(SEED_MESSAGES[1]);

      // Verify starts in INBOX
      expect(foldersOf("msg_to_archive")).toContain("INBOX");

      await executeAct({
        client: provider,
        executedRule,
        message,
        emailAccount,
        logger: createTestLogger(),
      });

      // Verify INBOX removed
      expect(foldersOf("msg_to_archive")).not.toContain("INBOX");

      // Verify status updated to APPLIED
      expect(mockExecutedRuleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ExecutedRuleStatus.APPLIED },
        }),
      );
    });

    test("MARK_READ action: removes UNREAD label", async () => {
      mockExecutedRuleUpdate.mockClear();

      const executedRule = buildExecutedRule("msg_to_label", [
        { id: "action-3", type: ActionType.MARK_READ },
      ]);

      const message = buildParsedMessage(SEED_MESSAGES[0]);

      await executeAct({
        client: provider,
        executedRule,
        message,
        emailAccount,
        logger: createTestLogger(),
      });

      // Verify UNREAD removed (mark as read), read back through the provider so
      // the label derivation is exercised too.
      expect(foldersOf("msg_to_label")).toBeDefined();
      expect(
        harness.mailbox.find((entry) => entry.id === "msg_to_label")?.unread,
      ).toBe(false);

      const after = await provider.getMessage("msg_to_label");
      expect(after.labelIds).not.toContain("UNREAD");
    });

    test("LABEL + ARCHIVE combined: labels then archives", async () => {
      mockExecutedRuleUpdate.mockClear();

      // msg_to_draft hasn't been touched yet — has INBOX + UNREAD
      const executedRule = buildExecutedRule("msg_to_draft", [
        { id: "action-4", type: ActionType.LABEL, label: "Processed" },
        { id: "action-5", type: ActionType.ARCHIVE },
      ]);

      const message = buildParsedMessage(SEED_MESSAGES[2]);

      await executeAct({
        client: provider,
        executedRule,
        message,
        emailAccount,
        logger: createTestLogger(),
      });

      // Verify label created and applied
      const processedLabel = harness.labels.find(
        (label) => label.name === "Processed",
      );
      expect(processedLabel).toBeDefined();

      // Label was applied
      expect(foldersOf("msg_to_draft")).toContain(processedLabel?.id);
      // INBOX was removed (archived)
      expect(foldersOf("msg_to_draft")).not.toContain("INBOX");

      // Single APPLIED status update
      expect(mockExecutedRuleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ExecutedRuleStatus.APPLIED },
        }),
      );
    });

    // Note: DRAFT_EMAIL action is tested separately in draft-creation.test.ts
    // The executeAct path for drafts has complex transitive dependencies
    // (MailComposer, handlePreviousDraftDeletion, etc.) that are better
    // tested in isolation.
  },
);
