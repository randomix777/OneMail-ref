/**
 * Integration test: stats loading reuses messages from pagination
 *
 * Verifies that saveBatch correctly processes messages returned by
 * getMessagesWithPagination without re-fetching them one by one.
 *
 * Uses the Nylas fake from the shared harness and mocks Prisma for DB writes.
 *
 * Usage:
 *   pnpm test-integration stats-reuse-messages
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createNylasTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
} from "./helpers";
import { saveBatch } from "@/utils/actions/stats-loading";
import { createTestLogger } from "@/__tests__/helpers";

// Mock Prisma — saveBatch writes to emailMessage table
const mockExecuteRaw = vi.fn().mockResolvedValue(0);
vi.mock("@/utils/prisma", () => ({
  default: {
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
  },
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

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === "true";
const BASE_MS = Date.UTC(2024, 3, 1, 12, 0, 0);

const SEED_MESSAGES: NylasSeedMessage[] = [
  {
    id: "msg_1",
    threadId: "thread_1",
    fromName: "Alice Smith",
    fromEmail: "alice@example.com",
    subject: "First email",
    body: 'Hello from Alice <a href="https://unsub.example.com/1">unsubscribe</a>',
    folders: ["INBOX"],
    unread: true,
    receivedAt: new Date(BASE_MS),
  },
  {
    id: "msg_2",
    threadId: "thread_2",
    fromName: "Bob",
    fromEmail: "bob@corp.com",
    subject: "Second email",
    body: "Hello from Bob",
    folders: ["INBOX"],
    receivedAt: new Date(BASE_MS + 60_000),
  },
  {
    id: "msg_3",
    threadId: "thread_3",
    fromName: "Carol",
    fromEmail: "carol@shop.io",
    subject: "Third email",
    body: "Hello from Carol",
    folders: ["INBOX", "SENT"],
    unread: true,
    receivedAt: new Date(BASE_MS + 120_000),
  },
];

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Stats: reuse messages from pagination",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    beforeAll(async () => {
      harness = await createNylasTestHarness({ messages: SEED_MESSAGES });
    });

    afterAll(() => {
      harness?.restoreFetch();
      if (process.env.RUN_INTEGRATION_TESTS) {
        delete process.env.NYLAS_API_KEY;
        delete process.env.NYLAS_API_URI;
      }
    });

    function runSaveBatch() {
      return saveBatch({
        emailAccountId: "test-account-id",
        emailProvider: harness.provider,
        logger: createTestLogger(),
        nextPageToken: undefined,
        before: undefined,
        after: undefined,
      });
    }

    test("saveBatch processes the provider's messages and saves them", async () => {
      mockExecuteRaw.mockClear();

      const result = await runSaveBatch();

      // Should return the messages
      expect(result.data.messages).toHaveLength(3);

      expect(mockExecuteRaw).toHaveBeenCalledTimes(1);

      const rawCall = JSON.stringify(mockExecuteRaw.mock.calls[0]);
      expect(rawCall).toContain("alice@example.com");
      expect(rawCall).toContain("bob@corp.com");
      expect(rawCall).toContain("carol@shop.io");

      // has UNREAD/INBOX labels
      expect(rawCall).toContain("false");
      expect(rawCall).toContain("true");
    });

    test("saveBatch refreshes mutable fields for cached messages", async () => {
      mockExecuteRaw.mockClear();

      await runSaveBatch();

      expect(mockExecuteRaw).toHaveBeenCalledTimes(1);

      const rawCall = JSON.stringify(mockExecuteRaw.mock.calls[0]);
      expect(rawCall).toContain("alice@example.com");
      expect(rawCall).toContain("false");
      expect(rawCall).toContain("true");
    });

    test("no per-message fetch is made for messages already paginated", async () => {
      harness.requests.length = 0;

      await runSaveBatch();

      // The paginated rows are complete enough to save, so every request should
      // be the list call: a single-message GET here would mean the batch was
      // re-fetched one message at a time.
      const singleMessageReads = harness.requests.filter((request) =>
        /\/messages\/[^/]+$/.test(request.url.pathname),
      );
      expect(singleMessageReads).toEqual([]);
      expect(harness.requests.length).toBeGreaterThan(0);
    });
  },
);
