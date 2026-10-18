import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createNylasTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
} from "@/__tests__/integration/helpers";
import {
  decodeMailboxSyncCursor,
  encodeMailboxSyncCursor,
} from "@/utils/email/mailbox-sync";

vi.mock("server-only", () => ({}));

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;

/**
 * `@/env` validates on first evaluation and the Nylas transport reads its URI
 * and key from it, so they have to be in place before the imports above resolve
 * — hence the hoisted block. Guarded so a skipped run never mutates the
 * environment other test files share.
 */
const nylasEnv = vi.hoisted(() => {
  const apiKey = "test-nylas-api-key";
  const origin = "https://nylas.test";
  if (process.env.RUN_INTEGRATION_TESTS) {
    process.env.NYLAS_API_KEY = apiKey;
    process.env.NYLAS_API_URI = origin;
  }

  return { apiKey, origin };
});

afterAll(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    delete process.env.NYLAS_API_KEY;
    delete process.env.NYLAS_API_URI;
  }
});

const GRANT_ID = "grant-abc";
const BASE_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const BASE_SECONDS = BASE_MS / 1000;
/** Two minutes of deliberate overlap, so each delta re-reads a little. */
const OVERLAP_SECONDS = 120;

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Nylas mailbox transport",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    beforeEach(async () => {
      harness = await createNylasTestHarness({ messages: seedMessages() });
    });

    afterEach(() => {
      harness.restoreFetch();
    });

    it("opens a delta window without paging the provider", async () => {
      // Nylas has no change log, so the first read only establishes "from here
      // on" — spending a request on it would be waste, and an empty mailbox is
      // not distinguishable from an unstarted window.
      const page = await harness.provider.getMailboxSyncPage({ limit: 50 });

      expect(harness.requests).toEqual([]);
      expect(page.upsertedMessages).toEqual([]);
      expect(page.deletedMessageIds).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.reset).toBe(false);

      const cursor = decodeMailboxSyncCursor(page.cursor, "nylas");
      expect(cursor.pageToken).toBeUndefined();
      expect(Date.parse(cursor.after)).toBeLessThanOrEqual(Date.now());
    });

    it("reads the window with overlap and authenticates with the grant id", async () => {
      const after = new Date(BASE_MS).toISOString();
      const page = await harness.provider.getMailboxSyncPage({
        cursor: encodeMailboxSyncCursor({
          version: 1,
          provider: "nylas",
          after,
        }),
        limit: 2,
      });

      expect(page.upsertedMessages.map((message) => message.id)).toEqual([
        "msg-3",
        "msg-2",
      ]);
      expect(page.hasMore).toBe(true);
      expect(page.reset).toBe(false);

      const [request] = harness.requests;
      expect(request.method).toBe("GET");
      // Nylas owns the Google tokens; our application key plus the grant is the
      // whole credential.
      expect(request.authorization).toBe(`Bearer ${nylasEnv.apiKey}`);
      expect(request.url.searchParams.get("fields")).toBe(
        "include_basic_headers",
      );
      expect(request.url.searchParams.get("received_after")).toBe(
        String(BASE_SECONDS - OVERLAP_SECONDS),
      );

      const cursor = decodeMailboxSyncCursor(page.cursor, "nylas");
      // The window only advances once a page sequence ends, or the messages
      // still queued behind the page token would be skipped.
      expect(cursor.after).toBe(after);
      expect(cursor.pageToken).toBe("2");
    });

    it("carries the page token forward and advances the window at the end", async () => {
      const after = new Date(BASE_MS).toISOString();
      const first = await harness.provider.getMailboxSyncPage({
        cursor: encodeMailboxSyncCursor({
          version: 1,
          provider: "nylas",
          after,
        }),
        limit: 2,
      });
      const second = await harness.provider.getMailboxSyncPage({
        cursor: first.cursor,
        limit: 2,
      });

      expect(harness.requests[1].url.searchParams.get("page_token")).toBe("2");
      expect(second.upsertedMessages.map((message) => message.id)).toEqual([
        "msg-1",
      ]);
      expect(second.hasMore).toBe(false);

      const cursor = decodeMailboxSyncCursor(second.cursor, "nylas");
      expect(cursor.pageToken).toBeUndefined();
      // `msg-1` is the only message on the last page, and the newest one read.
      expect(cursor.after).toBe(new Date(BASE_MS).toISOString());
    });

    it("hydrates a message into the engine's shape", async () => {
      const message = await harness.provider.getMessage("msg-1");

      expect(message.id).toBe("msg-1");
      expect(message.threadId).toBe("thread-1");
      expect(message.subject).toBe("First");
      // Hydration fetches the whole message, headers included, rather than
      // reusing the trimmed list payload.
      expect(message.textHtml).toContain("Hello from Ada");
      expect(message.bodyContentType).toBe("html");
      expect(message.headers.from).toBe("Ada Lovelace <ada@example.com>");
      expect(message.headers["message-id"]).toBe("<msg-1@example.com>");
      expect(message.internalDate).toBe(String(BASE_MS));
      // Roles and flags are derived from the Gmail-shaped label ids.
      expect(message.labelIds).toEqual(
        expect.arrayContaining(["INBOX", "UNREAD"]),
      );
      expect(message.labelIds).not.toContain("STARRED");
      expect(message.hasAttachment).toBe(false);

      expect(harness.requests[0].url.searchParams.get("fields")).toBe(
        "include_basic_headers",
      );
    });

    it("sends the whole folder set when removing a flag", async () => {
      // Nylas replaces folder membership rather than patching it, so the
      // read-modify-write has to send every folder the message keeps.
      await harness.provider.archiveMessage("msg-1");

      const put = harness.requests.find((request) => request.method === "PUT");
      expect(put?.url.pathname).toBe(`/v3/grants/${GRANT_ID}/messages/msg-1`);
      expect(put?.body).toEqual({ folders: ["UNREAD"] });
      expect(
        harness.mailbox.find((message) => message.id === "msg-1")?.folders,
      ).toEqual(["UNREAD"]);
    });

    it("skips the write when the folder flag is already present", async () => {
      // `msg-1` is already in INBOX, so unarchiving it reads and stops.
      await harness.provider.unarchiveMessages(["msg-1"]);
      expect(
        harness.requests.filter((request) => request.method === "PUT"),
      ).toEqual([]);

      // `msg-3` is not trashed, so this one writes — as a full folder set.
      await harness.provider.trashMessages(["msg-3"]);
      const put = harness.requests.find((request) => request.method === "PUT");
      expect(put?.url.pathname).toBe(`/v3/grants/${GRANT_ID}/messages/msg-3`);
      expect(put?.body).toEqual({ folders: ["INBOX", "STARRED", "TRASH"] });
    });

    it("patches a boolean flag without rewriting the folders", async () => {
      // Star and read state are real Nylas fields rather than folders, so they
      // are patched directly instead of read-modify-written.
      await harness.provider.markMessagesStarredState(["msg-1"], true);

      const put = harness.requests.find((request) => request.method === "PUT");
      expect(put?.url.pathname).toBe(`/v3/grants/${GRANT_ID}/messages/msg-1`);
      expect(put?.body).toEqual({ starred: true });
      expect(
        harness.mailbox.find((message) => message.id === "msg-1")?.starred,
      ).toBe(true);
    });
  },
);

function seedMessages(): NylasSeedMessage[] {
  return [
    {
      id: "msg-1",
      threadId: "thread-1",
      subject: "First",
      body: "<p>Hello from Ada</p>",
      folders: ["INBOX"],
      unread: true,
      receivedAt: new Date(BASE_MS),
    },
    {
      id: "msg-2",
      threadId: "thread-2",
      subject: "Second",
      body: "Plain reply",
      folders: ["INBOX", "STARRED"],
      starred: true,
      receivedAt: new Date(BASE_MS + 60_000),
    },
    {
      id: "msg-3",
      threadId: "thread-3",
      subject: "Third",
      folders: ["INBOX", "STARRED"],
      starred: true,
      receivedAt: new Date(BASE_MS + 120_000),
    },
  ];
}
