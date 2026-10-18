/**
 * Integration test: Nylas thread fetching & pagination
 *
 * Covers provider-level thread reads and pagination against the Nylas fake.
 * The Gmail-wrapper half of this file (`utils/gmail/thread.ts` helpers) went with
 * the direct Gmail transport: those helpers have no Nylas equivalent, because
 * thread reads belong to the provider interface.
 *
 * Usage:
 *   pnpm test-integration thread-fetching
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createNylasTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
} from "./helpers";

vi.mock("server-only", () => ({}));

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
const BASE_MS = Date.UTC(2024, 3, 1, 12, 0, 0);

/** Six messages across five threads, so one thread has real membership. */
function seedMessages(): NylasSeedMessage[] {
  return [
    {
      id: "msg_1",
      threadId: "thread_first",
      subject: "First thread",
      body: "Message one",
      folders: ["INBOX", "UNREAD"],
      unread: true,
      receivedAt: new Date(BASE_MS),
    },
    {
      id: "msg_1b",
      threadId: "thread_first",
      subject: "Re: First thread",
      body: "Message one, answered",
      folders: ["INBOX"],
      receivedAt: new Date(BASE_MS + 30_000),
    },
    {
      id: "msg_2",
      threadId: "thread_second",
      subject: "Second thread",
      body: "Message two",
      folders: ["INBOX"],
      receivedAt: new Date(BASE_MS + 60_000),
    },
    {
      id: "msg_3",
      threadId: "thread_third",
      subject: "Third thread",
      body: "Message three",
      folders: ["INBOX", "UNREAD"],
      unread: true,
      receivedAt: new Date(BASE_MS + 120_000),
    },
    {
      id: "msg_4",
      threadId: "thread_fourth",
      subject: "Fourth thread",
      body: "Message four",
      folders: ["INBOX"],
      receivedAt: new Date(BASE_MS + 180_000),
    },
    {
      id: "msg_5",
      threadId: "thread_fifth",
      subject: "Fifth thread",
      body: "Message five",
      folders: ["SENT"],
      receivedAt: new Date(BASE_MS + 240_000),
    },
  ];
}

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Thread fetching & pagination — Nylas",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    beforeAll(async () => {
      harness = await createNylasTestHarness({ messages: seedMessages() });
    });

    afterAll(() => {
      harness?.restoreFetch();
    });

    test("getThread returns a conversation with every message in it", async () => {
      const thread = await harness.provider.getThread("thread_first");

      expect(thread.id).toBe("thread_first");
      expect(thread.messages?.map((message) => message.id).sort()).toEqual([
        "msg_1",
        "msg_1b",
      ]);
    });

    test("getThreadMessages returns only that thread's messages", async () => {
      const messages = await harness.provider.getThreadMessages("thread_first");

      expect(messages.map((message) => message.id).sort()).toEqual([
        "msg_1",
        "msg_1b",
      ]);
      // A message from another thread must not leak into this conversation.
      expect(messages.some((message) => message.id === "msg_2")).toBe(false);
    });

    test("getMessagesWithPagination returns parsed messages with headers", async () => {
      const result = await harness.provider.getMessagesWithPagination({
        maxResults: 10,
      });

      expect(result.messages).toHaveLength(6);

      for (const message of result.messages) {
        expect(message.id).toBeDefined();
        expect(message.headers.from).toBeDefined();
        expect(message.headers.to).toBeDefined();
        expect(message.headers.subject).toBeDefined();
      }
    });

    test("getMessagesWithPagination paginates without repeating a message", async () => {
      const page1 = await harness.provider.getMessagesWithPagination({
        maxResults: 2,
      });

      expect(page1.messages).toHaveLength(2);
      expect(page1.nextPageToken).toBeDefined();

      const page2 = await harness.provider.getMessagesWithPagination({
        maxResults: 2,
        pageToken: page1.nextPageToken,
      });

      expect(page2.messages.length).toBeGreaterThanOrEqual(1);

      const page1Ids = new Set(page1.messages.map((message) => message.id));
      const duplicates = page2.messages.filter((message) =>
        page1Ids.has(message.id),
      );
      expect(duplicates).toHaveLength(0);
    });

    test("getMessagesWithPagination returns correct label data", async () => {
      const result = await harness.provider.getMessagesWithPagination({
        maxResults: 10,
      });

      // msg_1 has INBOX + UNREAD
      const msg1 = result.messages.find((message) => message.id === "msg_1");
      expect(msg1).toBeDefined();
      expect(msg1?.labelIds).toEqual(
        expect.arrayContaining(["INBOX", "UNREAD"]),
      );

      // msg_5 has SENT (not INBOX)
      const msg5 = result.messages.find((message) => message.id === "msg_5");
      expect(msg5).toBeDefined();
      expect(msg5?.labelIds).toContain("SENT");
      expect(msg5?.labelIds).not.toContain("INBOX");
    });
  },
);
