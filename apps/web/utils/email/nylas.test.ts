import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NylasMailProvider,
  NylasUnsupportedFeatureError,
} from "@/utils/email/nylas";
import { encodeMailboxSyncCursor } from "@/utils/email/mailbox-sync";
import { SafeError } from "@/utils/error";
import type { ParsedMessage } from "@/utils/types";

const nylasMail = vi.hoisted(() => ({
  listNylasMessages: vi.fn(),
  getNylasMessage: vi.fn(),
  listNylasThreadMessages: vi.fn(),
  listNylasThreads: vi.fn(),
  updateNylasMessage: vi.fn(),
  deleteNylasMessage: vi.fn(),
  sendNylasMessage: vi.fn(),
}));

const nylasClient = vi.hoisted(() => ({ nylasFetch: vi.fn() }));

const listNylasFolders = vi.hoisted(() => vi.fn());

const nylasContacts = vi.hoisted(() => ({
  searchNylasContacts: vi.fn(),
  listNylasContactPhotos: vi.fn(),
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/utils/nylas/mail", () => nylasMail);
vi.mock("@/utils/nylas/contacts", () => nylasContacts);
vi.mock("@/utils/nylas/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/nylas/client")>();
  return { ...actual, nylasFetch: nylasClient.nylasFetch };
});
vi.mock("@/utils/nylas/folder", async (importOriginal) => {
  // The role and mapping helpers are pure; only the network read is stubbed, so
  // folder-role resolution is exercised for real.
  const actual = await importOriginal<typeof import("@/utils/nylas/folder")>();
  return { ...actual, listNylasFolders };
});

const GRANT_ID = "grant-1";

const FOLDERS = [
  {
    id: "INBOX",
    name: "Inbox",
    attributes: ["\\Inbox"],
    total_count: 4,
    unread_count: 2,
  },
  { id: "SENT", name: "Sent", attributes: ["\\Sent"] },
  { id: "TRASH", name: "Trash", attributes: ["\\Trash"] },
  { id: "DRAFT", name: "Drafts", attributes: ["\\Drafts"] },
  { id: "Label_2", name: "Receipts" },
];

function provider() {
  return new NylasMailProvider({
    grantId: GRANT_ID,
    emailAccountId: "email-account-1",
  });
}

function message(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    historyId: "v1",
    date: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    internalDate: String(Date.parse("2026-01-01T00:00:00.000Z")),
    subject: "Hello",
    snippet: "Hello",
    labelIds: ["INBOX", "UNREAD"],
    headers: {
      from: "Ada <ada@example.com>",
      to: "me@example.com",
      subject: "Hello",
      date: "",
    },
    inline: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listNylasFolders.mockResolvedValue(FOLDERS);
  nylasMail.listNylasMessages.mockResolvedValue({
    messages: [],
    nextCursor: null,
  });
  nylasMail.listNylasThreads.mockResolvedValue({
    threads: [],
    nextCursor: null,
  });
  nylasMail.listNylasThreadMessages.mockResolvedValue([]);
  nylasMail.getNylasMessage.mockResolvedValue(null);
  nylasMail.updateNylasMessage.mockResolvedValue(undefined);
  nylasMail.sendNylasMessage.mockResolvedValue({
    id: "msg-sent",
    thread_id: "thread-1",
  });
});

describe("identity", () => {
  it("reports the Google family over the Nylas transport", () => {
    const mail = provider();

    // The family stays google so terminology, roles and error copy do not move.
    expect(mail.name).toBe("google");
    expect(mail.localMailSyncStrategy).toBe("account-history");
    expect(mail.toJSON()).toEqual({
      name: "google",
      type: "NylasMailProvider",
    });
  });

  it("exposes no provider access token, because Nylas holds it", () => {
    expect(provider().getAccessToken()).toBe("");
  });
});

describe("getMailboxSyncPage", () => {
  it("opens a delta window instead of paging the whole mailbox", async () => {
    const page = await provider().getMailboxSyncPage({ limit: 50 });

    expect(page.upsertedMessages).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.reset).toBe(false);
    expect(page.cursor).toBeTruthy();
    // Opening the window must not fetch anything; the first delta read does.
    expect(nylasMail.listNylasMessages).not.toHaveBeenCalled();
  });

  it("continues from the cursor's window with a small overlap", async () => {
    const after = "2026-01-01T00:00:00.000Z";
    const cursor = encodeMailboxSyncCursor({
      version: 1,
      provider: "nylas",
      after,
    });
    nylasMail.listNylasMessages.mockResolvedValue({
      messages: [{ id: "msg-1", thread_id: "thread-1", date: 1_767_225_600 }],
      nextCursor: null,
    });

    const page = await provider().getMailboxSyncPage({ cursor, limit: 50 });

    const query = nylasMail.listNylasMessages.mock.calls[0][0].query;
    expect(query.receivedAfter.getTime()).toBe(
      Date.parse(after) - 2 * 60 * 1000,
    );
    expect(page.upsertedMessages.map((m) => m.id)).toEqual(["msg-1"]);
    expect(page.hasMore).toBe(false);
  });

  it("reports more pages while a cursor remains and keeps the window", async () => {
    const after = "2026-01-01T00:00:00.000Z";
    const cursor = encodeMailboxSyncCursor({
      version: 1,
      provider: "nylas",
      after,
    });
    nylasMail.listNylasMessages.mockResolvedValue({
      messages: [],
      nextCursor: "cursor-2",
    });

    const page = await provider().getMailboxSyncPage({ cursor, limit: 50 });

    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBeTruthy();
  });

  it("rejects a cursor that belongs to another sync source", async () => {
    const microsoftCursor = encodeMailboxSyncCursor({
      version: 1,
      provider: "microsoft",
      deltaLink:
        "https://graph.microsoft.com/v1.0/me/mailFolders/('inbox')/messages/delta?$deltatoken=x",
      after: "2026-01-01T00:00:00.000Z",
      snapshot: false,
    });

    await expect(
      provider().getMailboxSyncPage({ cursor: microsoftCursor, limit: 50 }),
    ).rejects.toThrow("Invalid mailbox sync cursor");
  });
});

describe("reads", () => {
  it("throws when a message has vanished", async () => {
    await expect(provider().getMessage("msg-1")).rejects.toThrow(
      "Message msg-1 was not found",
    );
  });

  it("returns drafts only when the caller asks for them", async () => {
    nylasMail.listNylasThreadMessages.mockResolvedValue([
      {
        id: "msg-2",
        thread_id: "thread-1",
        date: 1_767_312_000,
        folders: ["DRAFT"],
      },
      {
        id: "msg-1",
        thread_id: "thread-1",
        date: 1_767_225_600,
        folders: ["INBOX"],
      },
    ]);

    const withoutDrafts = await provider().getThread("thread-1");
    const withDrafts = await provider().getThread("thread-1", {
      includeDrafts: true,
    });

    expect(withoutDrafts.messages.map((m) => m.id)).toEqual(["msg-1"]);
    expect(withDrafts.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
  });

  it("orders thread messages oldest first", async () => {
    nylasMail.listNylasThreadMessages.mockResolvedValue([
      { id: "newer", thread_id: "t", date: 1_767_312_000, folders: ["INBOX"] },
      { id: "older", thread_id: "t", date: 1_767_225_600, folders: ["INBOX"] },
    ]);

    const messages = await provider().getThreadMessages("t");

    expect(messages.map((m) => m.id)).toEqual(["older", "newer"]);
  });

  it("reads inbox statistics from the folder counters", async () => {
    await expect(provider().getInboxStats()).resolves.toEqual({
      total: 4,
      unread: 2,
    });
  });

  it("stops reporting a draft once it has been sent", async () => {
    // Sending keeps the message reachable by the same id, so a draft lookup that
    // only checked the id would claim a sent draft still exists.
    nylasMail.getNylasMessage.mockResolvedValue(
      message({ labelIds: ["SENT", "UNREAD"] }),
    );
    await expect(provider().getDraft("msg-1")).resolves.toBeNull();

    nylasMail.getNylasMessage.mockResolvedValue(
      message({ labelIds: ["DRAFT", "UNREAD"] }),
    );
    await expect(provider().getDraft("msg-1")).resolves.toMatchObject({
      id: "msg-1",
    });
  });
});

describe("mutations", () => {
  it("archives by removing the inbox label, the way Gmail does", async () => {
    nylasMail.getNylasMessage.mockResolvedValue(message());

    await provider().archiveMessages(["msg-1"]);

    expect(nylasMail.updateNylasMessage).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      messageId: "msg-1",
      folders: ["UNREAD"],
    });
  });

  it("does not write when the label is already absent", async () => {
    nylasMail.getNylasMessage.mockResolvedValue(
      message({ labelIds: ["Label_2"] }),
    );

    await provider().archiveMessages(["msg-1"]);

    expect(nylasMail.updateNylasMessage).not.toHaveBeenCalled();
  });

  it("marks read through the unread flag", async () => {
    await provider().markMessagesReadState(["msg-1"], true);

    expect(nylasMail.updateNylasMessage).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      messageId: "msg-1",
      unread: false,
    });
  });

  it("adds a label without dropping the existing ones", async () => {
    nylasMail.getNylasMessage.mockResolvedValue(message());

    await provider().labelMessage({
      messageId: "msg-1",
      labelId: "Label_2",
      labelName: "Receipts",
    });

    expect(nylasMail.updateNylasMessage).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      messageId: "msg-1",
      folders: ["INBOX", "UNREAD", "Label_2"],
    });
  });

  it("moves a message by keeping system labels and replacing the folder", async () => {
    nylasMail.listNylasThreadMessages.mockResolvedValue([
      {
        id: "msg-1",
        thread_id: "thread-1",
        date: 1_767_225_600,
        folders: ["INBOX", "UNREAD", "Label_9"],
      },
    ]);
    nylasMail.getNylasMessage.mockResolvedValue(
      message({ labelIds: ["INBOX", "UNREAD", "Label_9"] }),
    );

    await provider().moveThreadToFolder(
      "thread-1",
      "me@example.com",
      "Receipts",
    );

    // The old folder goes, the new one arrives, and roles survive the move.
    expect(nylasMail.updateNylasMessage).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      messageId: "msg-1",
      folders: ["INBOX", "UNREAD", "Label_2"],
    });
  });

  it("trashes a whole thread", async () => {
    nylasMail.listNylasThreadMessages.mockResolvedValue([
      { id: "msg-1", thread_id: "t", date: 1_767_225_600, folders: ["INBOX"] },
    ]);
    nylasMail.getNylasMessage.mockResolvedValue(message());

    await provider().trashThread("t", "me@example.com", "user");

    expect(nylasMail.updateNylasMessage).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      messageId: "msg-1",
      folders: ["INBOX", "UNREAD", "TRASH"],
    });
  });
});

describe("send", () => {
  it("sends HTML through the Nylas send endpoint", async () => {
    const result = await provider().sendEmailWithHtml({
      to: "ada@example.com",
      subject: "Hi",
      messageHtml: "<p>Hi</p>",
    });

    expect(result).toEqual({ messageId: "msg-sent", threadId: "thread-1" });
    expect(nylasMail.sendNylasMessage).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      body: expect.objectContaining({
        to: [{ email: "ada@example.com" }],
        subject: "Hi",
        body: "<p>Hi</p>",
      }),
    });
  });

  it("threads a reply onto the message it answers", async () => {
    await provider().replyToEmail(message(), "<p>Thanks</p>");

    expect(nylasMail.sendNylasMessage).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      body: expect.objectContaining({
        replyToMessageId: "msg-1",
        subject: "Re: Hello",
      }),
    });
  });
});

describe("features Nylas does not provide", () => {
  it("refuses to create a server-side filter rather than pretending", async () => {
    await expect(
      provider().createFilter({ from: "ada@example.com" }),
    ).rejects.toBeInstanceOf(NylasUnsupportedFeatureError);
  });

  it("reports a disabled feature as a known rejection, not an unexpected one", async () => {
    // The server-action layer returns a SafeError's message to the user and
    // only logs it. Any other error becomes "an unexpected error occurred" and
    // is reported to Sentry, which is the wrong shape for a provider limit the
    // user can do nothing about.
    const mail = provider();

    await expect(
      mail.createAutoArchiveFilter({ from: "ada@example.com" }),
    ).rejects.toBeInstanceOf(SafeError);
    await expect(mail.deleteFilter("filter-1")).rejects.toBeInstanceOf(
      SafeError,
    );
    await expect(
      mail.createFilter({ from: "ada@example.com" }),
    ).rejects.toThrow("server-side mail filters");
  });

  it("reports the rest of the filter surface as empty", async () => {
    await expect(provider().getFiltersList()).resolves.toEqual([]);
  });

  it("returns no send-as aliases, signatures, or forwarding addresses", async () => {
    const mail = provider();

    await expect(mail.getSendAsAddresses()).resolves.toEqual([]);
    await expect(mail.getSignatures()).resolves.toEqual([]);
    await expect(mail.getForwardingAddresses()).resolves.toEqual([]);
  });

  it("reads contacts and their photos from the Nylas Contacts API", async () => {
    // Contacts are supported by Nylas, so they are not part of the disabled set:
    // the provider delegates to the contacts module with its own grant.
    const contact = {
      emailAddress: "ada@example.com",
      name: "Ada Lovelace",
      profilePictureUrl: "https://example.com/ada.png",
    };
    nylasContacts.searchNylasContacts.mockResolvedValue([contact]);
    nylasContacts.listNylasContactPhotos.mockResolvedValue({
      "ada@example.com": "https://example.com/ada.png",
    });

    const mail = provider();

    await expect(mail.searchContacts("ada")).resolves.toEqual([contact]);
    await expect(mail.getContactPhotos()).resolves.toEqual({
      "ada@example.com": "https://example.com/ada.png",
    });
    expect(nylasContacts.searchNylasContacts).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: GRANT_ID, query: "ada" }),
    );
    expect(nylasContacts.listNylasContactPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: GRANT_ID }),
    );
  });

  it("refuses draft attachment editing", async () => {
    await expect(
      provider().startDraftAttachmentUpload("draft-1", {
        filename: "a.pdf",
        mimeType: "application/pdf",
        size: 10,
      }),
    ).rejects.toBeInstanceOf(NylasUnsupportedFeatureError);
  });

  it("reports no per-mailbox watch, because push is application-level", async () => {
    await expect(provider().watchEmails()).resolves.toBeNull();
  });
});

describe("predicates", () => {
  it("recognizes sent mail by its label", () => {
    expect(provider().isSentMessage(message({ labelIds: ["SENT"] }))).toBe(
      true,
    );
    expect(provider().isSentMessage(message())).toBe(false);
  });

  it("recognizes a reply by its threading headers", () => {
    expect(
      provider().isReplyInThread(
        message({ headers: { ...message().headers, "in-reply-to": "<x@y>" } }),
      ),
    ).toBe(true);
  });
});
