/**
 * Integration test: CALL_WEBHOOK action via @inbox-zero/emulate
 *
 * Tests the full webhook delivery flow: rule execution fires a
 * CALL_WEBHOOK action which POSTs email + rule details to a local
 * HTTP server. Verifies the payload structure and webhook secret header.
 *
 * Usage:
 *   pnpm test-integration webhook-action
 */

import http from "node:http";
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import {
  createNylasTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
} from "./helpers";
import { executeAct } from "@/utils/ai/choose-rule/execute";
import { ActionType, ExecutedRuleStatus } from "@/generated/prisma/enums";
import { createTestLogger } from "@/__tests__/helpers";

// Mock Prisma — executeAct updates status, callWebhook reads user secret
const mockExecutedRuleUpdate = vi.fn().mockResolvedValue({});
vi.mock("@/utils/prisma", () => ({
  default: {
    executedRule: {
      update: (...args: unknown[]) => mockExecutedRuleUpdate(...args),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        webhookSecret: "test-secret-abc123",
      }),
    },
  },
}));

const TEST_WEBHOOK_SECRET = "test-secret-abc123";

vi.mock("@inboxzero/tinybird", () => ({
  publishArchive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/ai/choose-rule/draft-management", () => ({
  updateExecutedActionWithDraftId: vi.fn().mockResolvedValue(undefined),
  handlePreviousDraftDeletion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/encryption", () => ({
  encrypt: vi.fn((s: string) => s),
  decrypt: vi.fn((s: string) => s),
}));

vi.mock("@/utils/log-error-with-dedupe", () => ({
  logErrorWithDedupe: vi.fn(),
}));

// Mock webhook URL validation to allow localhost
vi.mock("@/utils/outbound-webhook/url-validation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/utils/outbound-webhook/url-validation")
  >()),
  validateWebhookUrl: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("@inboxzero/network/safe-url", () => ({
  resolveSafeExternalHttpUrl: vi.fn(async (url: string) => ({
    url: new URL(url),
    lookup: (
      _hostname: string,
      options: number | { all?: boolean; family?: number } | undefined,
      callback: (
        error: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ) => {
      const normalizedOptions =
        typeof options === "number" ? { family: options } : options || {};

      if ("all" in normalizedOptions && normalizedOptions.all) {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
        return;
      }

      callback(null, "127.0.0.1", 4);
    },
  })),
}));

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const TEST_EMAIL = "webhook-test@example.com";
const WEBHOOK_PORT = 4108;

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
    id: "msg_webhook",
    threadId: "thread_webhook",
    fromName: "Sender",
    fromEmail: "sender@example.com",
    subject: "Trigger webhook",
    body: "This should trigger a webhook.",
    folders: ["INBOX"],
    unread: true,
    receivedAt: new Date(1_711_900_000_000),
  },
];

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "CALL_WEBHOOK action",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;
    let threadId: string;

    // Local HTTP server to receive webhook calls
    let webhookServer: http.Server;
    let receivedRequests: Array<{
      headers: http.IncomingHttpHeaders;
      body: string;
    }>;

    beforeAll(async () => {
      // Start webhook receiver
      receivedRequests = [];
      webhookServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          receivedRequests.push({ headers: req.headers, body });
          res.writeHead(200);
          res.end("OK");
        });
      });
      await new Promise<void>((resolve) =>
        webhookServer.listen(WEBHOOK_PORT, resolve),
      );

      // Start the Nylas fake via the shared harness
      harness = await createNylasTestHarness({
        messages: SEED_MESSAGES,
      });

      threadId = SEED_MESSAGES[0].threadId ?? SEED_MESSAGES[0].id;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) =>
        webhookServer?.close(() => resolve()),
      );
      harness?.restoreFetch();
      if (process.env.RUN_INTEGRATION_TESTS) {
        delete process.env.NYLAS_API_KEY;
        delete process.env.NYLAS_API_URI;
      }
    });

    test("CALL_WEBHOOK delivers payload with correct structure and secret", async () => {
      receivedRequests = [];

      const executedRule = {
        id: "exec-webhook-1",
        createdAt: new Date("2026-03-25T12:00:00Z"),
        updatedAt: new Date(),
        messageId: "msg_webhook",
        threadId,
        automated: true,
        reason: "Matched static from condition",
        status: ExecutedRuleStatus.APPLYING,
        ruleId: "rule-webhook-1",
        emailAccountId: "test-account-id",
        draftContextMetadata: null,
        draftModelName: null,
        draftModelProvider: null,
        draftPipelineVersion: null,
        matchReasons: null,
        actionItems: [
          {
            id: "action-webhook",
            type: ActionType.CALL_WEBHOOK,
            url: `http://localhost:${WEBHOOK_PORT}/webhook`,
            label: null,
            labelId: null,
            content: null,
            subject: null,
            to: null,
            cc: null,
            bcc: null,
            folderName: null,
            folderId: null,
            staticAttachments: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            executedRuleId: "exec-webhook-1",
          },
        ],
      };

      const message = {
        id: "msg_webhook",
        threadId,
        headers: {
          from: "sender@example.com",
          to: TEST_EMAIL,
          subject: "Trigger webhook",
          date: new Date(1_711_900_000_000).toISOString(),
          "message-id": "<msg_webhook@test>",
        },
        textPlain: "This should trigger a webhook.",
        textHtml: "",
        snippet: "This should trigger a webhook.",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1711900000000",
        historyId: "1",
        subject: "Trigger webhook",
        date: new Date(1_711_900_000_000).toISOString(),
        inline: [],
        attachments: [],
        rawRecipients: [],
      };

      await executeAct({
        client: harness.provider,
        executedRule,
        message,
        emailAccount: {
          email: TEST_EMAIL,
          id: "test-account-id",
          userId: "test-user-id",
        },
        logger: createTestLogger(),
      });

      // Verify webhook was called
      expect(receivedRequests).toHaveLength(1);

      const req = receivedRequests[0];

      // Verify secret header
      expect(req.headers["x-webhook-secret"]).toBe(TEST_WEBHOOK_SECRET);
      expect(req.headers["content-type"]).toBe("application/json");

      // Verify payload structure
      const payload = JSON.parse(req.body);

      expect(payload.email).toEqual({
        threadId,
        messageId: "msg_webhook",
        subject: "Trigger webhook",
        from: "sender@example.com",
        headerMessageId: "<msg_webhook@test>",
      });

      expect(payload.executedRule.id).toBe("exec-webhook-1");
      expect(payload.executedRule.ruleId).toBe("rule-webhook-1");
      expect(payload.executedRule.reason).toBe("Matched static from condition");
      expect(payload.executedRule.automated).toBe(true);
    });

    test("CALL_WEBHOOK + LABEL combined: webhook fires and label applied", async () => {
      receivedRequests = [];

      const executedRule = {
        id: "exec-combo-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        messageId: "msg_webhook",
        threadId,
        automated: true,
        reason: "Combined rule",
        status: ExecutedRuleStatus.APPLYING,
        ruleId: "rule-combo-1",
        emailAccountId: "test-account-id",
        draftContextMetadata: null,
        draftModelName: null,
        draftModelProvider: null,
        draftPipelineVersion: null,
        matchReasons: null,
        actionItems: [
          {
            id: "action-label-combo",
            type: ActionType.LABEL,
            label: "Webhooks",
            labelId: null,
            url: null,
            content: null,
            subject: null,
            to: null,
            cc: null,
            bcc: null,
            folderName: null,
            folderId: null,
            staticAttachments: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            executedRuleId: "exec-combo-1",
          },
          {
            id: "action-webhook-combo",
            type: ActionType.CALL_WEBHOOK,
            url: `http://localhost:${WEBHOOK_PORT}/webhook`,
            label: null,
            labelId: null,
            content: null,
            subject: null,
            to: null,
            cc: null,
            bcc: null,
            folderName: null,
            folderId: null,
            staticAttachments: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            executedRuleId: "exec-combo-1",
          },
        ],
      };

      const message = {
        id: "msg_webhook",
        threadId,
        headers: {
          from: "sender@example.com",
          to: TEST_EMAIL,
          subject: "Trigger webhook",
          date: new Date(1_711_900_000_000).toISOString(),
          "message-id": "<msg_webhook@test>",
        },
        textPlain: "This should trigger a webhook.",
        textHtml: "",
        snippet: "This should trigger a webhook.",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1711900000000",
        historyId: "1",
        subject: "Trigger webhook",
        date: new Date(1_711_900_000_000).toISOString(),
        inline: [],
        attachments: [],
        rawRecipients: [],
      };

      await executeAct({
        client: harness.provider,
        executedRule,
        message,
        emailAccount: {
          email: TEST_EMAIL,
          id: "test-account-id",
          userId: "test-user-id",
        },
        logger: createTestLogger(),
      });

      // Webhook was called
      expect(receivedRequests).toHaveLength(1);

      // Label was created and applied at the provider
      const webhookLabel = harness.labels.find(
        (label) => label.name === "Webhooks",
      );
      expect(webhookLabel).toBeDefined();

      const applied = await harness.provider.getMessage("msg_webhook");
      expect(applied.labelIds).toContain(webhookLabel?.id);
    });
  },
);
