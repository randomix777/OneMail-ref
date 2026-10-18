/**
 * Integration test: webhook → processHistoryItem → action execution
 *
 * Tests the inbound email processing pipeline against a local Gmail emulator.
 * Prisma and AI are mocked; Gmail API calls go through the real emulator.
 *
 * Usage:
 *   pnpm test-integration webhook-flow
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import {
  createNylasTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
} from "./helpers";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { executeAct } from "@/utils/ai/choose-rule/execute";
import {
  ActionType,
  ExecutedRuleStatus,
  DraftReplyConfidence,
} from "@/generated/prisma/enums";
import { getEmailAccount, createTestLogger } from "@/__tests__/helpers";

const mockExecutedRuleFindFirst = vi.fn().mockResolvedValue(null);
const mockExecutedRuleUpdate = vi.fn().mockResolvedValue({});

vi.mock("@/utils/prisma", () => ({
  default: {
    executedRule: {
      findFirst: (...args: unknown[]) => mockExecutedRuleFindFirst(...args),
      update: (...args: unknown[]) => mockExecutedRuleUpdate(...args),
    },
    newsletter: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    action: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

// Mock runRules to intercept rule matching and call executeAct directly.
// This lets us control WHICH rules match while testing real Gmail API execution.
let capturedRunRulesCall: {
  message: unknown;
  provider: unknown;
} | null = null;
let runRulesActions: Array<{
  type: ActionType;
  label?: string;
  labelId?: string;
}> = [];

vi.mock("@/utils/ai/choose-rule/run-rules", () => ({
  runRules: vi.fn(async ({ message, provider, logger }: any) => {
    capturedRunRulesCall = { message, provider };

    if (runRulesActions.length === 0) return [];

    const executedRule = {
      id: "exec-flow-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      messageId: message.id,
      threadId: message.threadId,
      automated: true,
      reason: "Integration test rule match",
      status: ExecutedRuleStatus.APPLYING,
      ruleId: "rule-flow-1",
      emailAccountId: "test-account-id",
      draftContextMetadata: null,
      draftModelName: null,
      draftModelProvider: null,
      draftPipelineVersion: null,
      matchReasons: null,
      actionItems: runRulesActions.map((action, i) => ({
        id: `action-flow-${i}`,
        type: action.type,
        label: action.label ?? null,
        labelId: action.labelId ?? null,
        content: null,
        subject: null,
        to: null,
        cc: null,
        bcc: null,
        url: null,
        folderName: null,
        folderId: null,
        staticAttachments: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        executedRuleId: "exec-flow-1",
      })),
    };

    await executeAct({
      client: provider,
      executedRule,
      message,
      emailAccount: {
        email: "webhook-flow@example.com",
        id: "test-account-id",
        userId: "test-user-id",
      },
      logger,
    });

    return [
      {
        rule: { id: "rule-flow-1", name: "Test Rule" },
        actionItems: executedRule.actionItems,
        reason: "Integration test",
        status: ExecutedRuleStatus.APPLIED,
        createdAt: new Date(),
      },
    ];
  }),
}));

vi.mock("@/utils/encryption", () => ({
  encrypt: vi.fn((s: string) => s),
  decrypt: vi.fn((s: string) => s),
}));

vi.mock("@inboxzero/tinybird", () => ({
  publishArchive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/ai/choose-rule/draft-management", () => ({
  updateExecutedActionWithDraftId: vi.fn().mockResolvedValue(undefined),
  handlePreviousDraftDeletion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/log-error-with-dedupe", () => ({
  logErrorWithDedupe: vi.fn(),
}));

vi.mock("@/utils/reply-tracker/draft-tracking", () => ({
  cleanupThreadAIDrafts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/follow-up/labels", () => ({
  clearFollowUpLabel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/categorize/senders/categorize", () => ({
  categorizeSender: vi.fn(),
}));

vi.mock("@/utils/reply-tracker/handle-outbound", () => ({
  handleOutboundMessage: vi.fn().mockResolvedValue(undefined),
}));

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const TEST_EMAIL = "webhook-flow@example.com";

// `@/env` validates on first evaluation and the Nylas transport reads its URI
// and key from it, so they have to be in place before the imports above resolve.
// Guarded so a run that skips these tests never touches the environment.
vi.hoisted(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    process.env.NYLAS_API_KEY = "test-nylas-api-key";
    process.env.NYLAS_API_URI = "https://nylas.test";
  }
});

const SEED_MESSAGES: NylasSeedMessage[] = [
  {
    id: "msg_inbound",
    threadId: "thread_inbound",
    fromName: "Customer",
    fromEmail: "customer@external.com",
    subject: "Support request #1234",
    body: "I need help with my account.",
    folders: ["INBOX"],
    unread: true,
    receivedAt: new Date(1_711_900_000_000),
  },
  {
    id: "msg_outbound",
    threadId: "thread_outbound",
    fromName: "Me",
    fromEmail: TEST_EMAIL,
    toEmail: "colleague@external.com",
    subject: "Meeting notes",
    body: "Here are the notes from today.",
    // Mail we sent: SENT and never INBOX, which is what marks it outbound.
    folders: ["SENT"],
    receivedAt: new Date(1_711_900_060_000),
  },
  {
    id: "msg_second_inbound",
    threadId: "thread_second_inbound",
    fromName: "Newsletter",
    fromEmail: "newsletter@updates.com",
    subject: "Weekly digest",
    body: "Here is your weekly update.",
    folders: ["INBOX"],
    unread: true,
    receivedAt: new Date(1_711_900_120_000),
  },
];

const THREAD_IDS = Object.fromEntries(
  SEED_MESSAGES.map((seed) => [seed.id, seed.threadId ?? seed.id]),
);

/**
 * Label state as the provider derives it, not as the fake stores it: a flag
 * change patches `unread` without rewriting the folder list, so reading the raw
 * mailbox would show a stale UNREAD.
 */
async function labelIdsOf(
  provider: NylasTestHarness["provider"],
  messageId: string,
) {
  const message = await provider.getMessage(messageId);
  return message.labelIds ?? [];
}

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Webhook → processHistoryItem → action execution",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    const logger = createTestLogger();

    const testEmailAccount = {
      ...getEmailAccount({ email: TEST_EMAIL }),
      autoCategorizeSenders: false,
      filingEnabled: false,
      filingPrompt: null,
      filingConfirmationSendEmail: false,
      draftReplyConfidence: DraftReplyConfidence.ALL_EMAILS,
    };

    function callProcessHistoryItem(
      messageId: string,
      overrides?: Partial<Parameters<typeof processHistoryItem>[1]>,
    ) {
      return processHistoryItem(
        { messageId, threadId: THREAD_IDS[messageId] },
        {
          provider: harness.provider,
          rules: [],
          hasAutomationRules: true,
          hasAiAccess: true,
          emailAccount: testEmailAccount,
          logger,
          ...overrides,
        },
      );
    }

    beforeAll(async () => {
      harness = await createNylasTestHarness({ messages: SEED_MESSAGES });
    });

    beforeEach(async () => {
      capturedRunRulesCall = null;
      runRulesActions = [];
      mockExecutedRuleFindFirst.mockReset().mockResolvedValue(null);
      mockExecutedRuleUpdate.mockReset().mockResolvedValue({});

      // Clear handleOutboundMessage call history so toHaveBeenCalled is accurate
      const { handleOutboundMessage } = await import(
        "@/utils/reply-tracker/handle-outbound"
      );
      vi.mocked(handleOutboundMessage).mockClear();
    });

    afterAll(() => {
      harness?.restoreFetch();
      if (process.env.RUN_INTEGRATION_TESTS) {
        delete process.env.NYLAS_API_KEY;
        delete process.env.NYLAS_API_URI;
      }
    });

    test("inbound message: fetches from the provider, runs rules, applies LABEL + ARCHIVE", async () => {
      runRulesActions = [
        { type: ActionType.LABEL, label: "Support" },
        { type: ActionType.ARCHIVE },
      ];

      const before = await labelIdsOf(harness.provider, "msg_inbound");
      expect(before).toContain("INBOX");
      expect(before).toContain("UNREAD");

      await callProcessHistoryItem("msg_inbound");

      // Verify runRules received the parsed message from the provider
      expect(capturedRunRulesCall).not.toBeNull();
      const capturedMessage = capturedRunRulesCall!.message as any;
      expect(capturedMessage.id).toBe("msg_inbound");
      expect(capturedMessage.headers.from).toContain("customer@external.com");
      expect(capturedMessage.headers.subject).toBe("Support request #1234");

      const after = await labelIdsOf(harness.provider, "msg_inbound");
      expect(after).not.toContain("INBOX");

      const supportLabel = harness.labels.find(
        (label) => label.name === "Support",
      );
      expect(supportLabel).toBeDefined();
      expect(after).toContain(supportLabel?.id);
    });

    test("outbound message: routes to handleOutboundMessage, no rules run", async () => {
      const { handleOutboundMessage } = await import(
        "@/utils/reply-tracker/handle-outbound"
      );

      await callProcessHistoryItem("msg_outbound");

      expect(capturedRunRulesCall).toBeNull();
      expect(handleOutboundMessage).toHaveBeenCalled();
    });

    test("duplicate prevention: second call for same message is skipped", async () => {
      runRulesActions = [{ type: ActionType.MARK_READ }];

      // Simulate rule already executed for this message
      mockExecutedRuleFindFirst.mockResolvedValueOnce({ id: "existing-exec" });

      await callProcessHistoryItem("msg_second_inbound");

      expect(capturedRunRulesCall).toBeNull();

      // Still unread: nothing ran.
      const unread = await labelIdsOf(harness.provider, "msg_second_inbound");
      expect(unread).toContain("UNREAD");
    });

    test("no AI access: message fetched but no rules run", async () => {
      runRulesActions = [{ type: ActionType.LABEL, label: "ShouldNotApply" }];

      await callProcessHistoryItem("msg_second_inbound", {
        hasAiAccess: false,
      });

      expect(capturedRunRulesCall).toBeNull();

      const badLabel = harness.labels.find(
        (label) => label.name === "ShouldNotApply",
      );
      expect(badLabel).toBeUndefined();
    });

    test("MARK_READ action: processes and marks message as read", async () => {
      runRulesActions = [{ type: ActionType.MARK_READ }];

      const before = await labelIdsOf(harness.provider, "msg_second_inbound");
      expect(before).toContain("UNREAD");

      await callProcessHistoryItem("msg_second_inbound");

      const after = await labelIdsOf(harness.provider, "msg_second_inbound");
      expect(after).not.toContain("UNREAD");
    });
  },
);
