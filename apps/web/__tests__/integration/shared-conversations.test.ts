import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createNylasTestHarness,
  createOutlookTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
  type OutlookTestHarness,
} from "./helpers";

// `@/env` validates on first evaluation and the Nylas transport reads its URI
// and key from it, so they have to be in place before the imports above resolve.
// Guarded so a run that skips these tests never touches the environment.
vi.hoisted(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    process.env.NYLAS_API_KEY = "test-nylas-api-key";
    process.env.NYLAS_API_URI = "https://nylas.test";
  }
});

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const outlookEmail = "shared-outlook@example.com";
const threadId = "team-comments-thread";
const historyCount = 25;

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "shared conversation complete provider retrieval — Nylas",
  { timeout: 60_000 },
  () => {
    let harness: NylasTestHarness;

    beforeAll(async () => {
      harness = await createNylasTestHarness({
        messages: sharedNylasMessages(),
      });
    });

    afterAll(() => {
      harness?.restoreFetch();
      if (process.env.RUN_INTEGRATION_TESTS) {
        delete process.env.NYLAS_API_KEY;
        delete process.env.NYLAS_API_URI;
      }
    });

    test("returns complete history and the changed-recipient branch without draft or unrelated mail", async () => {
      const thread = await harness.provider.getThread(threadId, {
        complete: true,
      });
      const bodies = thread.messages.map(
        (message) => `${message.textPlain ?? ""} ${message.textHtml ?? ""}`,
      );
      expect(thread.messages).toHaveLength(historyCount + 1);
      expect(bodies.some((body) => body.includes("History 24"))).toBe(true);
      expect(
        bodies.some((body) => body.includes("Changed recipient branch")),
      ).toBe(true);
      expect(bodies.some((body) => body.includes("Private draft"))).toBe(false);
      expect(bodies.some((body) => body.includes("Do not share"))).toBe(false);
    });
  },
);

function sharedNylasMessages(): NylasSeedMessage[] {
  return [
    ...Array.from({ length: historyCount }, (_, index) => ({
      id: `shared-history-${index}`,
      threadId,
      subject: "Team discussion",
      body: `History ${index}`,
      folders: ["INBOX"],
      receivedAt: new Date(1_790_000_000_000 + index * 1000),
    })),
    {
      id: "shared-changed-recipient",
      threadId,
      fromEmail: "shared-nylas@example.com",
      toEmail: "new-recipient@example.com",
      subject: "Re: Team discussion",
      body: "Changed recipient branch",
      folders: ["SENT"],
      receivedAt: new Date(1_790_000_030_000),
    },
    {
      id: "shared-draft",
      threadId,
      fromEmail: "shared-nylas@example.com",
      toEmail: "new-recipient@example.com",
      subject: "Re: Team discussion",
      body: "Private draft",
      folders: ["DRAFT"],
      receivedAt: new Date(1_790_000_040_000),
    },
    {
      id: "unrelated",
      threadId: "unrelated-thread",
      fromEmail: "other@example.com",
      subject: "Unrelated",
      body: "Do not share",
      folders: ["INBOX"],
      receivedAt: new Date(1_790_000_050_000),
    },
  ];
}

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "shared conversation complete provider retrieval — Microsoft",
  { timeout: 60_000 },
  () => {
    let harness: OutlookTestHarness;

    beforeAll(async () => {
      harness = await createOutlookTestHarness({
        email: outlookEmail,
        messages: [
          ...Array.from({ length: historyCount }, (_, index) => ({
            microsoft_id: `shared-history-${index}`,
            conversation_id: threadId,
            user_email: outlookEmail,
            from: { address: "sender@example.com" },
            to_recipients: [{ address: outlookEmail }],
            subject: "Team discussion",
            body_content: `History ${index}`,
            parent_folder_id: "inbox",
            is_read: true,
            received_date_time: new Date(
              Date.UTC(2026, 8, 22, 12, 0, index),
            ).toISOString(),
          })),
          {
            microsoft_id: "shared-changed-recipient",
            conversation_id: threadId,
            user_email: outlookEmail,
            from: { address: outlookEmail },
            to_recipients: [{ address: "new-recipient@example.com" }],
            subject: "Re: Team discussion",
            body_content: "Changed recipient branch",
            parent_folder_id: "sentitems",
            is_read: true,
            received_date_time: "2026-09-22T12:01:00Z",
          },
          {
            microsoft_id: "shared-draft",
            conversation_id: threadId,
            user_email: outlookEmail,
            from: { address: outlookEmail },
            to_recipients: [{ address: "new-recipient@example.com" }],
            subject: "Re: Team discussion",
            body_content: "Private draft",
            parent_folder_id: "drafts",
            is_read: true,
            is_draft: true,
            received_date_time: "2026-09-22T12:02:00Z",
          },
          {
            microsoft_id: "unrelated",
            conversation_id: "unrelated-thread",
            user_email: outlookEmail,
            from: { address: "other@example.com" },
            to_recipients: [{ address: outlookEmail }],
            subject: "Unrelated",
            body_content: "Do not share",
            parent_folder_id: "inbox",
            is_read: true,
            received_date_time: "2026-09-22T12:03:00Z",
          },
        ],
      });
    });

    afterAll(async () => {
      harness?.restoreFetch();
      await harness?.emulator.close();
    });

    test("follows Graph pages and excludes draft and unrelated mail", async () => {
      const thread = await harness.provider.getThread(threadId, {
        complete: true,
      });
      const bodies = thread.messages.map(
        (message) => `${message.textPlain ?? ""} ${message.textHtml ?? ""}`,
      );
      expect(thread.messages).toHaveLength(historyCount + 1);
      expect(bodies.some((body) => body.includes("History 24"))).toBe(true);
      expect(
        bodies.some((body) => body.includes("Changed recipient branch")),
      ).toBe(true);
      expect(bodies.some((body) => body.includes("Private draft"))).toBe(false);
      expect(bodies.some((body) => body.includes("Do not share"))).toBe(false);
    });
  },
);
