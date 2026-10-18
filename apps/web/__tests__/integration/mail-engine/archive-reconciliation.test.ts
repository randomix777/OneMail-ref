import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createMailEngine,
  createHostRuntime,
} from "@inboxzero/mail-core/engine";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import {
  createNylasTestHarness,
  createOutlookTestHarness,
} from "@/__tests__/integration/helpers";
import { createEmailProviderMailboxSource } from "@/utils/mail-api/source";
import { createEmailProviderOperationExecutor } from "@/utils/mail-api/operations";
import type { EmailProvider } from "@/utils/email/types";

vi.mock("server-only", () => ({}));
vi.mock("@inboxzero/tinybird", () => ({
  publishArchive: vi.fn().mockResolvedValue(undefined),
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
const inboxQuery = (accountId: string) => ({
  accountIds: [accountId],
  predicate: { kind: "role" as const, role: "inbox" as const },
  order: "newest_first" as const,
  pageSize: 25,
  after: null,
});

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "mail engine dual-provider archive slice",
  { timeout: 60_000 },
  () => {
    it("ingests Nylas mail, archives exact messages, and reconciles local state", async () => {
      const harness = await createNylasTestHarness({
        messages: [
          {
            id: "n-keep",
            subject: "Keep me",
            body: "Stay",
            folders: ["INBOX", "UNREAD"],
            unread: true,
            receivedAt: new Date(),
          },
          {
            id: "n-archive",
            subject: "Archive me",
            body: "Go",
            folders: ["INBOX", "UNREAD"],
            unread: true,
            receivedAt: new Date(Date.now() - 1000),
          },
        ],
      });
      try {
        const result = await runArchiveSlice({
          accountId: "nylas-engine",
          provider: harness.provider,
          archiveMessageId: "n-archive",
        });
        expect(result.before).toBe(2);
        expect(result.after).toBe(1);

        // Nylas replaces folder membership, so the archived message keeps
        // everything except INBOX.
        const archived = harness.mailbox.find(
          (message) => message.id === "n-archive",
        );
        expect(archived?.folders).not.toContain("INBOX");
        const kept = harness.mailbox.find((message) => message.id === "n-keep");
        expect(kept?.folders).toContain("INBOX");
      } finally {
        harness.restoreFetch();
      }
    });

    it("ingests Outlook emulator mail, archives exact messages, and reconciles local state", async () => {
      const email = "engine-outlook@example.com";
      const harness = await createOutlookTestHarness({
        email,
        messages: [
          {
            microsoft_id: "o-keep",
            conversation_id: "c-keep",
            user_email: email,
            from: { address: "ada@example.com" },
            to_recipients: [{ address: email }],
            subject: "Keep me",
            body_content: "Stay",
            parent_folder_id: "inbox",
            is_read: false,
            received_date_time: "2026-09-18T12:00:00Z",
          },
          {
            microsoft_id: "o-archive",
            conversation_id: "c-archive",
            user_email: email,
            from: { address: "ada@example.com" },
            to_recipients: [{ address: email }],
            subject: "Archive me",
            body_content: "Go",
            parent_folder_id: "inbox",
            is_read: false,
            received_date_time: "2026-09-18T11:00:00Z",
          },
        ],
      });
      try {
        const listed = await harness.provider.getMessagesWithPagination({
          maxResults: 20,
        });
        const archiveMessage = listed.messages.find(
          (message) => message.subject === "Archive me",
        );
        expect(archiveMessage?.id).toBeTruthy();
        const result = await runArchiveSlice({
          accountId: "outlook-engine",
          provider: harness.provider,
          archiveMessageId: archiveMessage!.id,
        });
        expect(result.before).toBeGreaterThanOrEqual(1);
        expect(result.after).toBe(result.before - 1);
        const archived = await harness.graphClient
          .api(`/me/messages/${archiveMessage!.id}`)
          .select("parentFolderId")
          .get();
        expect(String(archived.parentFolderId).toLowerCase()).not.toContain(
          "inbox",
        );
      } finally {
        harness.restoreFetch();
        await harness.emulator.close();
      }
    });
  },
);

async function runArchiveSlice(input: {
  accountId: string;
  provider: EmailProvider;
  archiveMessageId: string;
}) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: input.accountId,
    provider: input.provider.name,
    generation: "gen-1",
  });
  const engine = createMailEngine({
    store,
    source: createEmailProviderMailboxSource({
      provider: input.provider,
      accountId: input.accountId,
    }),
    executor: createEmailProviderOperationExecutor({
      provider: input.provider,
      accountId: input.accountId,
    }),
    runtime: createHostRuntime(),
  });
  await engine.requestSync([input.accountId]);
  await engine.runUntil(Date.now() + 8000);
  const before = await store.readMailboxView(inboxQuery(input.accountId));
  const admission = await engine.submitMetadata({
    accountId: input.accountId,
    commandId: `archive-${input.archiveMessageId}`,
    targets: [
      { accountId: input.accountId, messageId: input.archiveMessageId },
    ],
    change: { kind: "archive" },
  });
  expect(admission.status).toBe("queued");
  await engine.runUntil(Date.now() + 8000);
  const after = await store.readMailboxView(inboxQuery(input.accountId));
  const inspection = await store.inspect();
  const archived = inspection.messages.find(
    (message) => message.messageId === input.archiveMessageId,
  );
  expect(archived?.effective.roles.includes("inbox")).toBe(false);
  await engine.close();
  return {
    before: before.view.counts.matchingConversations,
    after: after.view.counts.matchingConversations,
  };
}
