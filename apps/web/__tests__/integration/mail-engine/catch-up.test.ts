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
vi.mock("@/utils/prisma", () => ({
  default: {
    emailSendOperation: { findUnique: vi.fn(), create: vi.fn() },
    snoozedThread: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));
vi.mock("@/utils/snooze/scheduler", () => ({
  prepareSnoozedThread: vi.fn(),
  activatePreparedSnoozedThread: vi.fn(),
  cancelSnoozedThreadByClientMutationId: vi.fn(),
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
  "mail engine dual-provider catch-up",
  { timeout: 60_000 },
  () => {
    it("rebuilds Nylas local state after an external archive", async () => {
      const harness = await createNylasTestHarness({
        messages: [
          {
            id: "n-keep-catch",
            subject: "Keep me",
            body: "Stay",
            folders: ["INBOX", "UNREAD"],
            unread: true,
            receivedAt: new Date(),
          },
          {
            id: "n-external-archive",
            subject: "Leave inbox elsewhere",
            body: "Go",
            folders: ["INBOX", "UNREAD"],
            unread: true,
            receivedAt: new Date(Date.now() - 1000),
          },
        ],
      });
      try {
        const store = await createSqliteMailStore(createNodeSqliteDriver());
        const engine = await startEngine({
          accountId: "nylas-catchup",
          provider: harness.provider,
          store,
        });
        const before = await store.readMailboxView(inboxQuery("nylas-catchup"));
        expect(before.view.counts.matchingConversations).toBe(2);

        // Somewhere else left the inbox. Nylas has no change log, so the engine
        // only learns this by re-reading the window on catch-up.
        const external = harness.mailbox.find(
          (message) => message.id === "n-external-archive",
        );
        if (!external) throw new Error("seed message missing");
        external.folders = ["UNREAD"];

        await engine.runUntil(Date.now() + 8000);
        const after = await store.readMailboxView(inboxQuery("nylas-catchup"));
        const inspection = await store.inspect();
        const archived = inspection.messages.find(
          (message) => message.messageId === "n-external-archive",
        );
        expect(archived?.effective.roles.includes("inbox")).toBe(false);
        expect(after.view.counts.matchingConversations).toBe(1);

        // A second pass over the same window must not re-add it.
        await engine.runUntil(Date.now() + 4000);
        const duplicate = await store.readMailboxView(
          inboxQuery("nylas-catchup"),
        );
        expect(duplicate.view.counts.matchingConversations).toBe(1);
        await engine.close();
      } finally {
        harness.restoreFetch();
      }
    });

    it("applies Outlook folder moves discovered on delta catch-up", async () => {
      const email = "engine-outlook-catchup@example.com";
      const harness = await createOutlookTestHarness({
        email,
        messages: [
          {
            microsoft_id: "o-keep-catch",
            conversation_id: "c-keep-catch",
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
            microsoft_id: "o-moved-catch",
            conversation_id: "c-moved-catch",
            user_email: email,
            from: { address: "ada@example.com" },
            to_recipients: [{ address: email }],
            subject: "Move me",
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
        const moved = listed.messages.find(
          (message) => message.subject === "Move me",
        );
        expect(moved?.id).toBeTruthy();
        const store = await createSqliteMailStore(createNodeSqliteDriver());
        const engine = await startEngine({
          accountId: "outlook-catchup",
          provider: harness.provider,
          store,
        });
        const before = await store.readMailboxView(
          inboxQuery("outlook-catchup"),
        );
        expect(before.view.counts.matchingConversations).toBeGreaterThanOrEqual(
          2,
        );
        await harness.provider.archiveMessages([moved!.id]);
        await engine.runUntil(Date.now() + 8000);
        const inspection = await store.inspect();
        const local = inspection.messages.find(
          (message) => message.messageId === moved!.id,
        );
        expect(local?.effective.roles.includes("inbox")).toBe(false);
        const archived = await harness.graphClient
          .api(`/me/messages/${moved!.id}`)
          .select("parentFolderId")
          .get();
        expect(String(archived.parentFolderId).toLowerCase()).not.toContain(
          "inbox",
        );
        await engine.close();
      } finally {
        harness.restoreFetch();
        await harness.emulator.close();
      }
    });
  },
);

async function startEngine(input: {
  accountId: string;
  provider: EmailProvider;
  store: Awaited<ReturnType<typeof createSqliteMailStore>>;
}) {
  await input.store.ensureAccount({
    accountId: input.accountId,
    provider: input.provider.name,
    generation: "gen-1",
  });
  const engine = createMailEngine({
    store: input.store,
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
  return engine;
}
