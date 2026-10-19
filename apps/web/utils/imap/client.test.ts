import { describe, expect, it } from "vitest";
import {
  classifyMailbox,
  type ImapMailbox,
  resolveMailboxRoles,
} from "@/utils/imap/client";

function mailbox(
  path: string,
  options: { name?: string; specialUse?: string } = {},
): ImapMailbox {
  return {
    path,
    name: options.name ?? path,
    specialUse: options.specialUse,
    ...classifyMailbox({
      path,
      name: options.name ?? path,
      specialUse: options.specialUse,
    }),
  };
}

describe("classifyMailbox", () => {
  it("trusts a special-use attribute over the name", () => {
    // A provider is free to call it anything; the attribute is the contract.
    expect(
      classifyMailbox({
        path: "Weird Folder",
        name: "Weird Folder",
        specialUse: "\\Sent",
      }),
    ).toEqual({ role: "sent", roleInferred: false });
  });

  it("recognises the inbox without an attribute", () => {
    expect(classifyMailbox({ path: "INBOX", name: "INBOX" })).toEqual({
      role: "inbox",
      roleInferred: false,
    });
    expect(classifyMailbox({ path: "inbox", name: "inbox" }).role).toBe(
      "inbox",
    );
  });

  it.each([
    ["Sent", "sent"],
    ["Sent Items", "sent"],
    ["Drafts", "draft"],
    ["Trash", "trash"],
    ["Deleted Messages", "trash"],
    ["Junk", "spam"],
    ["Spam", "spam"],
    ["Archive", "archive"],
    ["All Mail", "archive"],
  ])("falls back to the name %s", (name, role) => {
    expect(classifyMailbox({ path: name, name })).toEqual({
      role,
      roleInferred: true,
    });
  });

  it("reads the leaf of a nested path", () => {
    // Providers nest with a delimiter, so the interesting part is the last
    // segment: `[Gmail]/Sent Mail`, `INBOX.Sent`.
    expect(
      classifyMailbox({ path: "[Gmail]/Sent Mail", name: "Sent Mail" }),
    ).toEqual({ role: "sent", roleInferred: true });
    expect(classifyMailbox({ path: "INBOX.Trash", name: "Trash" }).role).toBe(
      "trash",
    );
  });

  it("maps the provider-specific spellings found in the wild", () => {
    // Fastmail documents exactly these names; it says `Spam` where others say
    // `Junk`, and `Archive` where Gmail says `All Mail`.
    for (const name of ["Spam", "Archive"]) {
      expect(classifyMailbox({ path: name, name }).role).toBeDefined();
    }
  });

  it("leaves a folder it cannot place unassigned", () => {
    expect(classifyMailbox({ path: "Projects", name: "Projects" })).toEqual({});
  });
});

describe("resolveMailboxRoles", () => {
  it("prefers attributes and fills the gaps from names", () => {
    const roles = resolveMailboxRoles([
      mailbox("INBOX"),
      mailbox("Sent", { specialUse: "\\Sent" }),
      mailbox("Drafts"),
      mailbox("Trash"),
    ]);

    expect(roles.get("inbox")?.path).toBe("INBOX");
    expect(roles.get("sent")?.path).toBe("Sent");
    expect(roles.get("draft")?.path).toBe("Drafts");
    expect(roles.get("trash")?.path).toBe("Trash");
  });

  it("does not let a name guess displace an attribute", () => {
    const roles = resolveMailboxRoles([
      // Two folders look like Sent, but only one says so.
      mailbox("Sent"),
      mailbox("Sent Items", { specialUse: "\\Sent" }),
    ]);

    expect(roles.get("sent")?.path).toBe("Sent Items");
  });

  it("leaves a role unassigned when two mailboxes both claim the attribute", () => {
    const roles = resolveMailboxRoles([
      mailbox("Sent", { specialUse: "\\Sent" }),
      mailbox("Sent Again", { specialUse: "\\Sent" }),
    ]);

    // Guessing between them would file sent mail into the wrong folder.
    expect(roles.has("sent")).toBe(false);
  });

  it("picks the first of two name guesses rather than none", () => {
    // A guess is safe to take when nothing contradicts it; the risk it carries
    // (a folder named like Sent that is not Sent) is smaller than losing the
    // role entirely, which would make sent mail unfindable.
    const roles = resolveMailboxRoles([
      mailbox("Sent"),
      mailbox("Sent Messages"),
    ]);

    expect(roles.get("sent")?.path).toBe("Sent");
  });

  it("resolves a real Fastmail-shaped listing", () => {
    const roles = resolveMailboxRoles([
      mailbox("Inbox"),
      mailbox("Archive"),
      mailbox("Drafts"),
      mailbox("Sent"),
      mailbox("Spam"),
      mailbox("Trash"),
    ]);

    expect([...roles.keys()].sort()).toEqual([
      "archive",
      "draft",
      "inbox",
      "sent",
      "spam",
      "trash",
    ]);
  });
});
