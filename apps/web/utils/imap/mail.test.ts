import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import {
  getImapMailboxSyncPage,
  groupImapMessagesIntoThreads,
} from "@/utils/imap/mail";
import { InvalidMailboxSyncCursorError } from "@/utils/email/mailbox-sync";

function summary(uid: number) {
  return {
    uid,
    envelope: {
      subject: `Message ${uid}`,
      messageId: `<m${uid}@example.com>`,
      date: new Date("2026-03-01T00:00:00.000Z"),
      from: [{ address: "ada@example.com", name: "Ada" }],
      to: [{ address: "owner@example.com" }],
    },
    internalDate: new Date("2026-03-01T00:00:00.000Z"),
    size: 100,
    flags: new Set<string>(),
  };
}

/**
 * A client that answers only what the delta path asks for.
 *
 * `fetch` yields every message, like a server does: it does not know the range
 * it was given, which is deliberate — it forces the code under test to filter,
 * which is where the `n:*` duplication bug lives.
 */
function fakeClient({
  uidValidity,
  uids,
}: {
  uidValidity: bigint | null;
  uids: number[];
}): ImapFlow {
  return {
    mailbox: { uidNext: Math.max(0, ...uids) + 1 },
    status: async () =>
      uidValidity === null ? false : { uidValidity, path: "INBOX" },
    getMailboxLock: async () => ({ release: () => undefined }),
    fetch: async function* () {
      for (const uid of uids) yield summary(uid);
    },
  } as unknown as ImapFlow;
}

describe("getImapMailboxSyncPage", () => {
  it("asks for a full read when the server reports no UIDVALIDITY", async () => {
    const page = await getImapMailboxSyncPage({
      client: fakeClient({ uidValidity: null, uids: [1] }),
      folderId: "INBOX",
      limit: 10,
      accountEmail: "owner@example.com",
    });

    // Without a generation there is nothing to version UIDs by, so a delta
    // could not be trusted.
    expect(page.reset).toBe(true);
    expect(page.upsertedMessages).toEqual([]);
  });

  it("resets when the mailbox has been renumbered", async () => {
    const first = await getImapMailboxSyncPage({
      client: fakeClient({ uidValidity: BigInt(1), uids: [1, 2, 3] }),
      folderId: "INBOX",
      limit: 10,
      accountEmail: "owner@example.com",
    });
    expect(first.reset).toBe(false);

    const second = await getImapMailboxSyncPage({
      client: fakeClient({ uidValidity: BigInt(2), uids: [1, 2, 3] }),
      folderId: "INBOX",
      cursor: first.cursor,
      limit: 10,
      accountEmail: "owner@example.com",
    });

    // Every stored UID is meaningless in a new generation.
    expect(second.reset).toBe(true);
  });

  it("resets when the cursor belongs to another mailbox", async () => {
    const first = await getImapMailboxSyncPage({
      client: fakeClient({ uidValidity: BigInt(1), uids: [1] }),
      folderId: "INBOX",
      limit: 10,
      accountEmail: "owner@example.com",
    });

    const second = await getImapMailboxSyncPage({
      client: fakeClient({ uidValidity: BigInt(1), uids: [1] }),
      folderId: "Sent",
      cursor: first.cursor,
      limit: 10,
      accountEmail: "owner@example.com",
    });

    expect(second.reset).toBe(true);
  });

  it("reports only messages newer than the last UID", async () => {
    const first = await getImapMailboxSyncPage({
      client: fakeClient({ uidValidity: BigInt(1), uids: [1, 2] }),
      folderId: "INBOX",
      limit: 10,
      accountEmail: "owner@example.com",
    });
    expect(first.upsertedMessages.map((m) => m.id)).toEqual([
      "INBOX:1",
      "INBOX:2",
    ]);

    const second = await getImapMailboxSyncPage({
      client: fakeClient({ uidValidity: BigInt(1), uids: [1, 2, 3] }),
      folderId: "INBOX",
      cursor: first.cursor,
      limit: 10,
      accountEmail: "owner@example.com",
    });

    // `2:*` also returns UID 2; re-inserting it on every poll is the bug this
    // guards.
    expect(second.upsertedMessages.map((m) => m.id)).toEqual(["INBOX:3"]);
    expect(second.reset).toBe(false);
  });

  it("keeps the cursor on the newest UID it reported", async () => {
    const page = await getImapMailboxSyncPage({
      client: fakeClient({ uidValidity: BigInt(1), uids: [1, 2, 3] }),
      folderId: "INBOX",
      limit: 2,
      accountEmail: "owner@example.com",
    });

    expect(page.hasMore).toBe(true);
    expect(page.upsertedMessages).toHaveLength(2);
    // The cursor must stop at the last reported message, not at the highest UID,
    // or the trimmed page would be skipped forever.
    expect(page.upsertedMessages.map((m) => m.id)).toEqual([
      "INBOX:1",
      "INBOX:2",
    ]);
  });

  it("rejects a cursor it cannot parse rather than silently starting over", async () => {
    await expect(
      getImapMailboxSyncPage({
        client: fakeClient({ uidValidity: BigInt(1), uids: [1] }),
        folderId: "INBOX",
        cursor: "not-a-cursor",
        limit: 10,
        accountEmail: "owner@example.com",
      }),
    ).rejects.toBeInstanceOf(InvalidMailboxSyncCursorError);
  });
});

describe("groupImapMessagesIntoThreads", () => {
  it("groups a reply with its parent", () => {
    const threads = groupImapMessagesIntoThreads([
      { messageId: "<a@example.com>" },
      {
        messageId: "<b@example.com>",
        inReplyTo: "<a@example.com>",
        references: "<a@example.com>",
      },
    ]);

    expect(threads.get("<a@example.com>")).toEqual([
      "<a@example.com>",
      "<b@example.com>",
    ]);
  });

  it("roots a deep chain at its first message", () => {
    const threads = groupImapMessagesIntoThreads([
      { messageId: "<a@example.com>" },
      {
        messageId: "<b@example.com>",
        references: "<a@example.com>",
      },
      {
        messageId: "<c@example.com>",
        references: "<a@example.com> <b@example.com>",
      },
    ]);

    expect(threads.size).toBe(1);
    expect(threads.get("<a@example.com>")).toEqual([
      "<a@example.com>",
      "<b@example.com>",
      "<c@example.com>",
    ]);
  });

  it("keeps unrelated messages in their own threads", () => {
    const threads = groupImapMessagesIntoThreads([
      { messageId: "<a@example.com>" },
      { messageId: "<x@example.com>" },
    ]);

    expect(threads.size).toBe(2);
  });

  it("does not hang on a reference cycle", () => {
    const threads = groupImapMessagesIntoThreads([
      { messageId: "<a@example.com>", references: "<b@example.com>" },
      { messageId: "<b@example.com>", references: "<a@example.com>" },
    ]);

    // A malformed chain must terminate; which root it picks matters less than
    // returning at all.
    expect(threads.size).toBe(1);
  });
});
