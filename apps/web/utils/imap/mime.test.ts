import { describe, expect, it } from "vitest";
import { applyImapSource, imapFlagsToLabelIds, toParsedMessage } from "./mime";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    uid: 42,
    folderId: "INBOX",
    envelope: {
      subject: "Quarterly numbers",
      messageId: "<m42@example.com>",
      date: new Date("2026-03-01T00:00:00.000Z"),
      from: [{ address: "ada@example.com", name: "Ada" }],
      to: [{ address: "owner@example.com" }],
      inReplyTo: "<m41@example.com>",
    },
    internalDate: new Date("2026-03-01T00:00:00.000Z"),
    size: 100,
    flags: new Set<string>(),
    ...overrides,
  } as never;
}

describe("imapFlagsToLabelIds", () => {
  it("reports unread unless the message carries \\Seen", () => {
    expect(imapFlagsToLabelIds({ folderId: "INBOX", flags: [] })).toContain(
      "UNREAD",
    );
    expect(
      imapFlagsToLabelIds({
        folderId: "INBOX",
        flags: new Set(["\\Seen"]),
      }),
    ).not.toContain("UNREAD");
  });

  it("drops a stale UNREAD when the server says the message was read", () => {
    // A sync page can hand over flags that disagree with the label list it was
    // built from; the flag is the authority for read state.
    const ids = imapFlagsToLabelIds({
      folderId: "INBOX",
      flags: ["\\Seen"],
      labelIds: ["UNREAD", "label-1"],
    });

    expect(ids).not.toContain("UNREAD");
    expect(ids).toContain("label-1");
  });

  it("maps the flags the app derives state from", () => {
    const ids = imapFlagsToLabelIds({
      folderId: "INBOX",
      flags: new Set(["\\Flagged", "\\Draft", "\\Answered"]),
    });

    expect(ids).toEqual(
      expect.arrayContaining(["STARRED", "DRAFT", "ANSWERED"]),
    );
  });

  it("keeps the mailbox as a label, so a folder behaves like one", () => {
    expect(imapFlagsToLabelIds({ folderId: "Archive", flags: [] })).toContain(
      "Archive",
    );
  });

  it("matches flags case-insensitively", () => {
    // Servers are inconsistent about the case of keyword flags.
    expect(
      imapFlagsToLabelIds({ folderId: "INBOX", flags: ["\\seen"] }),
    ).not.toContain("UNREAD");
  });
});

describe("toParsedMessage", () => {
  it("namespaces the id by mailbox, because a UID is only unique inside one", () => {
    const message = toParsedMessage(summary(), "owner@example.com");

    expect(message.id).toBe("INBOX:42");
    expect(message.parentFolderId).toBe("INBOX");
  });

  it("threads on the message id so a reply joins its conversation", () => {
    const message = toParsedMessage(summary(), "owner@example.com");

    expect(message.threadId).toBe("<m42@example.com>");
    expect(message.headers["in-reply-to"]).toBe("<m41@example.com>");
  });

  it("falls back to the mailbox id when a message has no Message-ID", () => {
    const message = toParsedMessage(
      summary({ envelope: { subject: "No id", date: new Date() } }),
      "owner@example.com",
    );

    expect(message.threadId).toBe("INBOX:42");
  });

  it("leaves the body empty, because listing does not transfer it", () => {
    const message = toParsedMessage(summary(), "owner@example.com");

    expect(message.textPlain).toBe("");
    expect(message.textHtml).toBe("");
    expect(message.attachments).toEqual([]);
  });

  it("writes the account address when the envelope has no sender", () => {
    const message = toParsedMessage(
      summary({ envelope: { subject: "Anonymous", date: new Date() } }),
      "owner@example.com",
    );

    expect(message.headers.from).toBe("owner@example.com");
  });

  it("formats addresses the way the rest of the app reads them", () => {
    const message = toParsedMessage(summary(), "owner@example.com");

    expect(message.headers.from).toBe("Ada <ada@example.com>");
    expect(message.headers.to).toBe("owner@example.com");
  });
});

describe("applyImapSource", () => {
  const plainSource = Buffer.from(
    [
      "From: Ada <ada@example.com>",
      "To: owner@example.com",
      "Subject: Quarterly numbers",
      "Message-ID: <m42@example.com>",
      "References: <m41@example.com>",
      "List-Unsubscribe: <https://example.com/unsub>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The numbers are attached.",
      "",
    ].join("\r\n"),
  );

  it("fills the body and the snippet from the source", async () => {
    const message = await applyImapSource({
      message: toParsedMessage(summary(), "owner@example.com"),
      source: plainSource,
    });

    expect(message.textPlain).toContain("The numbers are attached.");
    expect(message.snippet).toBe("The numbers are attached.");
  });

  it("reads threading and unsubscribe headers from the parsed message", async () => {
    const message = await applyImapSource({
      message: toParsedMessage(summary(), "owner@example.com"),
      source: plainSource,
    });

    expect(message.headers.references).toBe("<m41@example.com>");
    expect(message.headers["list-unsubscribe"]).toBe(
      "<https://example.com/unsub>",
    );
  });

  it("reports attachments without materialising their bytes", async () => {
    const source = Buffer.from(
      [
        "From: Ada <ada@example.com>",
        "To: owner@example.com",
        "Subject: With a file",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "See attached.",
        "--b1",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0xLjQK",
        "--b1--",
        "",
      ].join("\r\n"),
    );

    const message = await applyImapSource({
      message: toParsedMessage(summary(), "owner@example.com"),
      source,
    });

    expect(message.hasAttachment).toBe(true);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0]).toMatchObject({
      filename: "report.pdf",
      mimeType: "application/pdf",
      // The id is derived from the message id and the part's position.
      attachmentId: "INBOX:42-0",
    });
    // PostalMime reports how it decoded the part, not the sender's encoding.
    expect(message.attachments?.[0]?.headers["content-transfer-encoding"]).toBe(
      "",
    );
  });

  it("keeps an invitation's calendar content for the meeting flow", async () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const source = Buffer.from(
      [
        "From: Ada <ada@example.com>",
        "To: owner@example.com",
        "Subject: Invitation",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/calendar; method=REQUEST",
        "",
        calendar,
        "--b1--",
        "",
      ].join("\r\n"),
    );

    const message = await applyImapSource({
      message: toParsedMessage(summary(), "owner@example.com"),
      source,
    });

    expect(message.calendarContent).toContain("BEGIN:VEVENT");
  });

  it("strips markup out of the snippet for an HTML-only message", async () => {
    const source = Buffer.from(
      [
        "From: Ada <ada@example.com>",
        "To: owner@example.com",
        "Subject: HTML",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hello <strong>there</strong></p>",
        "",
      ].join("\r\n"),
    );

    const message = await applyImapSource({
      message: toParsedMessage(summary(), "owner@example.com"),
      source,
    });

    expect(message.snippet).toBe("Hello there");
  });
});
