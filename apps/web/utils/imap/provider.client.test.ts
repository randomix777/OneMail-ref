import type { ImapFlow } from "imapflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftNotFoundError } from "@/utils/error";
import { ImapMailProvider, ImapUnsupportedFeatureError } from "./provider";

/**
 * The provider is exercised through a fake connection: `withImapConnection` is
 * the only thing stubbed, so the folder roles, MIME mapping, cursor and flag code
 * all run for real against a client that records what it was asked to do.
 */

const operations: string[] = [];
const locks: string[] = [];
let mailboxes: Array<{
  path: string;
  name: string;
  specialUse?: string;
}> = [];
let messagesByUid = new Map<number, ReturnType<typeof summary>>();
/** The mailbox the fake client currently has open, which its reads follow. */
let openFolder = "INBOX";

function summary(uid: number, overrides: Record<string, unknown> = {}) {
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
    folderId: "INBOX",
    source: Buffer.from(
      "From: ada@example.com\r\nTo: owner@example.com\r\nSubject: Message\r\nMessage-ID: <m1@example.com>\r\nDate: Sun, 1 Mar 2026 00:00:00 +0000\r\n\r\nHello\r\n",
    ),
    ...overrides,
  };
}

function fakeClient(): ImapFlow {
  return {
    mailbox: { uidNext: 100 },
    list: async () => mailboxes,
    status: async () => ({ messages: 2, unseen: 1, path: "INBOX" }),
    getMailboxLock: async (path: string) => {
      locks.push(path);
      openFolder = path;
      return { release: () => undefined };
    },
    fetch: async function* () {
      for (const message of messagesByUid.values()) {
        if (message.folderId && message.folderId !== openFolder) continue;
        yield message;
      }
    },
    fetchOne: async (uid: string) => messagesByUid.get(Number(uid)) ?? false,
    search: async (query: unknown) => {
      const wanted = (query as { header?: { "message-id"?: string } }).header?.[
        "message-id"
      ];
      if (!wanted) return [...messagesByUid.keys()];
      const found: number[] = [];
      for (const message of messagesByUid.values()) {
        if (message.envelope?.messageId === wanted) found.push(message.uid);
      }
      return found;
    },
    messageFlagsAdd: async (
      range: string,
      flags: string[],
      options: unknown,
    ) => {
      operations.push(
        `add ${flags.join(",")} ${range} uid=${String((options as { uid?: boolean }).uid)}`,
      );
      return true;
    },
    messageFlagsRemove: async (
      range: string,
      flags: string[],
      options: unknown,
    ) => {
      operations.push(
        `remove ${flags.join(",")} ${range} uid=${String((options as { uid?: boolean }).uid)}`,
      );
      return true;
    },
    messageMove: async (range: string, destination: string) => {
      operations.push(`move ${range} -> ${destination}`);
      return true;
    },
    messageDelete: async (range: string, options: unknown) => {
      operations.push(
        `delete ${range} uid=${String((options as { uid?: boolean }).uid)}`,
      );
      return true;
    },
    append: async (path: string, content: string, flags?: string[]) => {
      operations.push(`append ${path} ${flags?.join(",") ?? ""}`.trim());
      const source = String(content);
      const messageId = source.match(/Message-ID: <([^>]+)>/)?.[1];
      const to = source.match(/To: (.*)\r?\n/)?.[1] ?? "someone@example.com";
      const uid = messagesByUid.size + 1;
      messagesByUid.set(
        uid,
        summary(uid, {
          envelope: {
            subject: source.match(/Subject: (.*)\r?\n/)?.[1] ?? "Draft",
            messageId: `<${messageId ?? `m${uid}@example.com`}>`,
            date: new Date("2026-03-01T00:00:00.000Z"),
            from: [{ address: "owner@example.com" }],
            to: to.split(",").map((entry) => ({ address: entry.trim() })),
          },
          source: Buffer.from(source),
          folderId: path,
        }),
      );
      return { destination: path, uid };
    },
  } as unknown as ImapFlow;
}

vi.mock("@/utils/imap/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/imap/client")>();
  return {
    ...actual,
    // The boundary: everything above it runs for real.
    withImapConnection: async (
      _options: unknown,
      work: (client: ImapFlow) => Promise<unknown>,
    ) => work(fakeClient()),
  };
});

// `vi.mock` is hoisted above these declarations, so the fake has to be created in
// the same hoisted step rather than as a top-level const.
const { sendViaSmtp } = vi.hoisted(() => ({
  sendViaSmtp: vi.fn(async () => ({
    messageId: "<sent@example.com>",
    raw: Buffer.from("raw message"),
  })),
}));

vi.mock("@/utils/imap/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/imap/send")>();
  return { ...actual, sendViaSmtp };
});

function provider(family: "fastmail" | "zoho" = "fastmail") {
  return new ImapMailProvider({
    family,
    emailAccountId: "email-account-1",
    email: "owner@example.com",
    username: "owner@example.com",
    secret: "app-password",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      trace: () => undefined,
      with: () => undefined,
    } as never,
  });
}

beforeEach(() => {
  operations.length = 0;
  locks.length = 0;
  mailboxes = [
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
    // Named the way Fastmail names it, to prove the role comes from the
    // attribute or a known name rather than a hardcoded "SENT".
    { path: "Sent Items", name: "Sent Items", specialUse: "\\Sent" },
    { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
    { path: "Trash", name: "Trash", specialUse: "\\Trash" },
    { path: "Archive", name: "Archive", specialUse: "\\Archive" },
  ];
  messagesByUid = new Map([[1, summary(1)]]);
  openFolder = "INBOX";
});

describe("ImapMailProvider folders and labels", () => {
  it("reports the server's mailboxes as folders", async () => {
    expect(await provider().getFolders()).toEqual([
      { id: "INBOX", displayName: "INBOX" },
      { id: "Sent Items", displayName: "Sent Items" },
      { id: "Drafts", displayName: "Drafts" },
      { id: "Trash", displayName: "Trash" },
      { id: "Archive", displayName: "Archive" },
    ]);
  });

  it("types labels as folders, because IMAP has no other kind", async () => {
    const labels = await provider().getLabels();

    expect(labels[0]).toEqual({
      id: "INBOX",
      name: "INBOX",
      type: "folder",
    });
  });

  it("finds a label by name without caring about case", async () => {
    expect(await provider().getLabelByName("archive")).toEqual({
      id: "Archive",
      name: "Archive",
      type: "folder",
    });
    expect(await provider().getLabelByName("nope")).toBeNull();
  });
});

describe("ImapMailProvider mutations", () => {
  it("flags read state on the mailbox the message lives in", async () => {
    await provider().markMessagesReadState(["Archive:42"], true);
    await provider().markMessagesReadState(["Archive:42"], false);

    expect(operations).toEqual([
      "add \\Seen 42 uid=true",
      "remove \\Seen 42 uid=true",
    ]);
  });

  it("flags starred state with the IMAP flag rather than a field", async () => {
    await provider().markMessagesStarredState(["INBOX:7"], true);

    expect(operations).toEqual(["add \\Flagged 7 uid=true"]);
  });

  it("archives by moving to the resolved archive mailbox", async () => {
    await provider().archiveMessages(["INBOX:7"]);

    expect(operations).toEqual(["move 7 -> Archive"]);
  });

  it("trashes by moving to the resolved trash mailbox", async () => {
    await provider().trashMessages(["INBOX:7"]);

    expect(operations).toEqual(["move 7 -> Trash"]);
  });

  it("refuses to archive when the server has no archive mailbox", async () => {
    // Guessing a destination would either fail at the server or file mail
    // somewhere the user did not ask for.
    mailboxes = [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" }];

    await expect(provider().archiveMessages(["INBOX:7"])).rejects.toThrow(
      ImapUnsupportedFeatureError,
    );
  });

  it("skips messages already in the destination", async () => {
    await provider().archiveMessages(["Archive:7"]);

    expect(operations).toEqual([]);
  });
});

describe("ImapMailProvider drafts", () => {
  it("writes a draft into the Drafts mailbox", async () => {
    const created = await provider().createDraft({
      to: "ada@example.com",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });

    expect(created.id.endsWith("@example.com")).toBe(true);
    expect(operations).toContain("append Drafts \\Draft");
  });

  it("refuses to write a draft when the server has no Drafts mailbox", async () => {
    // A draft written somewhere the user will not look for it is a lost draft.
    mailboxes = [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" }];

    await expect(
      provider().createDraft({
        to: "ada@example.com",
        subject: "Hello",
        messageHtml: "<p>Hi</p>",
      }),
    ).rejects.toThrow(ImapUnsupportedFeatureError);
  });

  it("reads a draft back by the id it was given", async () => {
    const created = await provider().createDraft({
      to: "ada@example.com",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });

    const draft = await provider().getDraft(created.id);

    expect(draft?.subject).toBe("Hello");
    expect(draft?.headers.to).toContain("ada@example.com");
  });

  it("keeps the same draft id when the draft is rewritten", async () => {
    const created = await provider().createDraft({
      to: "ada@example.com",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });

    await provider().updateDraft(created.id, {
      to: "ada@example.com",
      subject: "Hello again",
      messageHtml: "<p>Hi again</p>",
    });

    const draft = await provider().getDraft(created.id);
    expect(draft?.subject).toBe("Hello again");
  });

  it("removes the copy a rewrite replaced", async () => {
    const created = await provider().createDraft({
      to: "ada@example.com",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });

    await provider().updateDraft(created.id, {
      to: "ada@example.com",
      subject: "Hello again",
      messageHtml: "<p>Hi again</p>",
    });

    // The old copy would otherwise sit next to the new one in Drafts.
    expect(operations.some((entry) => entry.startsWith("move "))).toBe(true);
  });

  it("lists the drafts in the Drafts mailbox", async () => {
    await provider().createDraft({
      to: "ada@example.com",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });

    const drafts = await provider().getDrafts();

    expect(drafts).toHaveLength(1);
    expect(drafts[0].subject).toBe("Hello");
  });

  it("throws away a draft that is gone", async () => {
    expect(await provider().getDraft("missing@example.com")).toBeNull();
    expect(await provider().deleteDraft("missing@example.com")).toBe(false);
  });
});

describe("ImapMailProvider draft attachments", () => {
  async function draftWithFile() {
    const created = await provider().createDraft({
      to: "ada@example.com",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });

    const added = await provider().addDraftAttachment(created.id, {
      id: "file-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      disposition: "attachment",
      content: Buffer.from("hello", "utf8"),
    });

    return { draftId: created.id, added };
  }

  it("puts the file on the draft", async () => {
    const { added } = await draftWithFile();

    expect(added.attachments).toHaveLength(1);
    expect(added.attachments[0].filename).toBe("notes.txt");
    expect(added.attachments[0].size).toBe(5);
  });

  it("gives the file an id that survives a rewrite", async () => {
    const { draftId, added } = await draftWithFile();

    // Rewriting the text replaces the message, so the id has to come from
    // something the rewrite carries over.
    await provider().updateDraft(draftId, {
      to: "ada@example.com",
      subject: "Hello again",
      messageHtml: "<p>Hi again</p>",
    });

    const listed = await provider().getDraftAttachments(draftId);
    expect(listed?.attachments[0].id).toBe(added.attachmentId);
  });

  it("keeps the file when the text is rewritten", async () => {
    const { draftId } = await draftWithFile();

    await provider().updateDraft(draftId, {
      to: "ada@example.com",
      subject: "Hello again",
      messageHtml: "<p>Hi again</p>",
    });

    const listed = await provider().getDraftAttachments(draftId);
    expect(listed?.attachments).toHaveLength(1);
  });

  it("removes a file from the draft", async () => {
    const { draftId, added } = await draftWithFile();

    const removed = await provider().removeDraftAttachment(
      draftId,
      added.attachmentId,
    );

    expect(removed.attachments).toHaveLength(0);
  });

  it("refuses to attach to a draft that is gone", async () => {
    await expect(
      provider().addDraftAttachment("missing@example.com", {
        id: "file-1",
        filename: "notes.txt",
        mimeType: "text/plain",
        size: 5,
        disposition: "attachment",
        content: Buffer.from("hello", "utf8"),
      }),
    ).rejects.toThrow(DraftNotFoundError);
  });
});

describe("ImapMailProvider sending", () => {
  it("appends its own Sent copy for a mailbox that does not file one", async () => {
    const result = await provider("fastmail").sendEmail({
      to: "ada@example.com",
      subject: "Hello",
      messageText: "Hi",
    });

    expect(result.messageId).toBe("<sent@example.com>");
    // Fastmail does not file a copy, so dropping the append would lose sent mail.
    expect(operations).toEqual(["append Sent Items \\Seen"]);
  });

  it("lets the provider file the copy for Zoho, whose SMTP already does", async () => {
    await provider("zoho").sendEmail({
      to: "ada@example.com",
      subject: "Hello",
      messageText: "Hi",
    });

    // Appending here as well would show two copies in Sent.
    expect(operations).toEqual([]);
  });

  it("sends a plain-text body without an HTML part", async () => {
    await provider().sendEmail({
      to: "ada@example.com",
      subject: "Hello",
      messageText: "a < b",
    });

    const message = sendViaSmtp.mock.calls.at(-1)?.[0] as {
      message: Record<string, unknown>;
    };
    expect(message.message.text).toBe("a < b");
    expect(message.message.html).toBeUndefined();
  });

  it("splits comma-separated recipients into an envelope", async () => {
    await provider().sendEmail({
      to: "ada@example.com, bob@example.com",
      subject: "Hello",
      messageText: "Hi",
    });

    const message = sendViaSmtp.mock.calls.at(-1)?.[0] as {
      message: Record<string, unknown>;
    };
    expect(message.message.to).toEqual(["ada@example.com", "bob@example.com"]);
  });
});

describe("ImapMailProvider reading", () => {
  it("reads one message by its namespaced id", async () => {
    const message = await provider().getMessage("INBOX:1");

    expect(message.id).toBe("INBOX:1");
    expect(message.subject).toBe("Message 1");
  });

  it("refuses a message id that could point anywhere", async () => {
    await expect(provider().getMessage("INBOX:not-a-uid")).rejects.toThrow(
      /Invalid/,
    );
  });

  it("reads sent mail from the resolved mailbox, not a hardcoded name", async () => {
    await provider().getSentMessages(5);

    // The fake server names its sent mailbox "Sent Items", so a hardcoded "SENT"
    // would either fail to resolve or lock a mailbox that does not exist.
    expect(locks).toEqual(["Sent Items"]);
    expect(mailboxes.some((mailbox) => mailbox.path === "SENT")).toBe(false);
  });
});

describe("ImapMailProvider unsupported capabilities", () => {
  it("refuses what a plain IMAP client cannot do, with a readable message", async () => {
    const emailProvider = provider();

    await expect(emailProvider.searchMessages()).rejects.toThrow(
      /does not support searching the mailbox/,
    );
    await expect(emailProvider.createFilter()).rejects.toThrow(
      ImapUnsupportedFeatureError,
    );
    await expect(emailProvider.getSignatures()).resolves.toEqual([]);
  });

  it("returns no send-as aliases and no photos rather than failing", async () => {
    const emailProvider = provider();

    // Empty is the true answer here, not an error: IMAP exposes neither.
    await expect(emailProvider.getSendAsAddresses()).resolves.toEqual([]);
    await expect(emailProvider.getContactPhotos()).resolves.toEqual({});
  });

  it("has no push subscription to renew", async () => {
    await expect(provider().watchEmails()).resolves.toBeNull();
  });
});
