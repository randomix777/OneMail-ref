import { describe, expect, it } from "vitest";
import { toParsedMessage, type NylasMessage } from "@/utils/nylas/message";

function message(overrides: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    subject: "Quarterly update",
    from: [{ name: "Ada", email: "ada@example.com" }],
    to: [{ name: "Grace", email: "grace@example.com" }],
    date: 1_700_000_000,
    snippet: "Here is the update",
    body: "<p>Here is the update</p>",
    folders: ["INBOX"],
    unread: true,
    starred: false,
    ...overrides,
  };
}

describe("toParsedMessage", () => {
  it("carries the identity, participants, and timestamps", () => {
    const parsed = toParsedMessage(message());

    expect(parsed.id).toBe("msg-1");
    expect(parsed.threadId).toBe("thread-1");
    expect(parsed.subject).toBe("Quarterly update");
    expect(parsed.snippet).toBe("Here is the update");
    expect(parsed.headers.from).toBe("Ada <ada@example.com>");
    expect(parsed.headers.to).toBe("Grace <grace@example.com>");
    // Nylas dates are Unix seconds.
    expect(parsed.date).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parsed.internalDate).toBe(String(1_700_000_000_000));
  });

  it("falls back to the message id when Nylas reports no thread", () => {
    expect(toParsedMessage(message({ thread_id: null })).threadId).toBe(
      "msg-1",
    );
  });

  it("keeps Gmail-shaped folder ids as labels so roles survive", () => {
    const parsed = toParsedMessage(
      message({ folders: ["INBOX", "CATEGORY_UPDATES", "Label_2"] }),
    );

    expect(parsed.labelIds).toEqual(
      expect.arrayContaining(["INBOX", "CATEGORY_UPDATES", "Label_2"]),
    );
  });

  it("treats the unread boolean as authoritative in both directions", () => {
    // Nylas reports UNREAD as its own folder for Google grants, which means the
    // list can be stale relative to the flag.
    expect(
      toParsedMessage(message({ folders: ["INBOX"], unread: true })).labelIds,
    ).toContain("UNREAD");
    expect(
      toParsedMessage(message({ folders: ["INBOX", "UNREAD"], unread: false }))
        .labelIds,
    ).not.toContain("UNREAD");
  });

  it("treats the starred boolean as authoritative in both directions", () => {
    expect(toParsedMessage(message({ starred: true })).labelIds).toContain(
      "STARRED",
    );
    expect(
      toParsedMessage(
        message({ folders: ["INBOX", "STARRED"], starred: false }),
      ).labelIds,
    ).not.toContain("STARRED");
  });

  it("leaves the folder list alone when the flags are absent", () => {
    const parsed = toParsedMessage(
      message({ folders: ["INBOX", "UNREAD"], unread: undefined }),
    );

    expect(parsed.labelIds).toContain("UNREAD");
  });

  it("records an archived message as having no inbox label", () => {
    // Archiving removes INBOX rather than adding an ARCHIVE label, which is how
    // the engine already reads Gmail.
    const parsed = toParsedMessage(message({ folders: ["Label_2"] }));

    expect(parsed.labelIds).not.toContain("INBOX");
    expect(parsed.labelIds).not.toContain("ARCHIVE");
  });

  it("reads an HTML body as HTML", () => {
    const parsed = toParsedMessage(message({ body: "<p>Hello</p>" }));

    expect(parsed.bodyContentType).toBe("html");
    expect(parsed.textHtml).toBe("<p>Hello</p>");
    expect(parsed.textPlain).toBeUndefined();
  });

  it("reads a plain-text body as plain text", () => {
    const parsed = toParsedMessage(message({ body: "Hello 1 < 2 and 3 > 2" }));

    expect(parsed.bodyContentType).toBe("text");
    expect(parsed.textPlain).toBe("Hello 1 < 2 and 3 > 2");
    expect(parsed.textHtml).toBeUndefined();
  });

  it("omits body fields for a message with no body", () => {
    const parsed = toParsedMessage(message({ body: null }));

    expect(parsed.bodyContentType).toBeUndefined();
    expect(parsed.textHtml).toBeUndefined();
    expect(parsed.textPlain).toBeUndefined();
  });

  it("splits inline attachments from file attachments", () => {
    const parsed = toParsedMessage(
      message({
        attachments: [
          {
            id: "att-file",
            filename: "report.pdf",
            content_type: "application/pdf",
            size: 10,
          },
          {
            id: "att-inline",
            filename: "logo.png",
            content_type: "image/png",
            content_id: "logo@example.com",
            size: 20,
          },
        ],
      }),
    );

    expect(parsed.attachments?.map((a) => a.attachmentId)).toEqual([
      "att-file",
    ]);
    expect(parsed.inline.map((a) => a.attachmentId)).toEqual(["att-inline"]);
    expect(parsed.inline[0].headers["content-id"]).toBe("logo@example.com");
    expect(parsed.hasAttachment).toBe(true);
  });

  it("treats an attachment the provider marks inline as inline", () => {
    const parsed = toParsedMessage(
      message({
        attachments: [{ id: "att-1", filename: "logo.png", is_inline: true }],
      }),
    );

    expect(parsed.inline.map((a) => a.attachmentId)).toEqual(["att-1"]);
    expect(parsed.attachments).toEqual([]);
  });

  it("substitutes a MIME type Nylas could not determine", () => {
    const parsed = toParsedMessage(
      message({
        attachments: [{ id: "att-1", filename: "ü.pdf", content_type: "" }],
      }),
    );

    expect(parsed.attachments?.[0].mimeType).toBe("application/octet-stream");
  });

  it("reports no attachments when there are none", () => {
    const parsed = toParsedMessage(message({ attachments: [] }));

    expect(parsed.hasAttachment).toBe(false);
    expect(parsed.attachments).toEqual([]);
  });

  it("recognizes a meeting invitation from a calendar part", () => {
    const parsed = toParsedMessage(
      message({
        attachments: [
          {
            id: "att-1",
            filename: "invite.ics",
            content_type: "text/calendar",
          },
        ],
      }),
    );

    expect(parsed.isMeetingInvitation).toBe(true);
  });

  it("recognizes a meeting invitation from the body", () => {
    const parsed = toParsedMessage(
      message({ body: "BEGIN:VCALENDAR\nMETHOD:REQUEST" }),
    );

    expect(parsed.isMeetingInvitation).toBe(true);
  });

  it("does not mistake an ordinary message for an invitation", () => {
    expect(toParsedMessage(message()).isMeetingInvitation).toBe(false);
  });

  it("reads threading headers when Nylas was asked to include them", () => {
    const parsed = toParsedMessage(
      message({
        headers: [
          { name: "Message-ID", value: "<abc@example.com>" },
          { name: "In-Reply-To", value: "<parent@example.com>" },
          { name: "References", value: "<parent@example.com>" },
          { name: "List-Unsubscribe", value: "<mailto:u@example.com>" },
        ],
      }),
    );

    expect(parsed.headers["message-id"]).toBe("<abc@example.com>");
    expect(parsed.headers["in-reply-to"]).toBe("<parent@example.com>");
    expect(parsed.headers.references).toBe("<parent@example.com>");
    expect(parsed.headers["list-unsubscribe"]).toBe("<mailto:u@example.com>");
  });

  it("keeps the first value when Nylas repeats a header", () => {
    const parsed = toParsedMessage(
      message({
        headers: [
          { name: "Message-ID", value: "<first@example.com>" },
          { name: "Message-ID", value: "<second@example.com>" },
        ],
      }),
    );

    expect(parsed.headers["message-id"]).toBe("<first@example.com>");
  });

  it("uses the reply-to address rather than the sender when given one", () => {
    const parsed = toParsedMessage(
      message({ reply_to: [{ name: "Support", email: "help@example.com" }] }),
    );

    expect(parsed.headers["reply-to"]).toBe("Support <help@example.com>");
  });

  it("derives a version that changes with observable metadata", () => {
    const base = toParsedMessage(message());

    expect(base.historyId).toBeTruthy();
    expect(toParsedMessage(message({ starred: true })).historyId).not.toBe(
      base.historyId,
    );
    expect(toParsedMessage(message({ subject: "Other" })).historyId).not.toBe(
      base.historyId,
    );
    expect(toParsedMessage(message()).historyId).toBe(base.historyId);
  });
});
