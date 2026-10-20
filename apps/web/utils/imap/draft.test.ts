import { describe, expect, it } from "vitest";
import {
  buildImapDraftSource,
  createImapDraftMessageId,
  readImapDraftAttachments,
} from "./draft";

describe("buildImapDraftSource", () => {
  const base = {
    from: { address: "owner@example.com", name: "Owner" },
    to: [{ address: "someone@example.com" }],
    subject: "Hello",
    html: "<p>Hi there</p>",
    messageId: "abc123@example.com",
  };

  it("writes the headers a draft needs to be read back", () => {
    const source = buildImapDraftSource(base);

    expect(source).toContain("From: Owner <owner@example.com>");
    expect(source).toContain("To: someone@example.com");
    expect(source).toContain("Subject: Hello");
    expect(source).toContain("Message-ID: <abc123@example.com>");
    expect(source).toContain("MIME-Version: 1.0");
  });

  it("carries the threading headers of a reply", () => {
    const source = buildImapDraftSource({
      ...base,
      inReplyTo: "original@example.com",
      references: ["first@example.com", "original@example.com"],
    });

    expect(source).toContain("In-Reply-To: <original@example.com>");
    expect(source).toContain(
      "References: <first@example.com> <original@example.com>",
    );
  });

  it("encodes a subject that is not plain ASCII", () => {
    const source = buildImapDraftSource({ ...base, subject: "你好" });

    expect(source).toContain("Subject: =?UTF-8?B?");
    expect(source).not.toContain("Subject: 你好");
  });

  it("sends the body as base64 in the line lengths MIME asks for", () => {
    const source = buildImapDraftSource({
      ...base,
      html: `<p>${"a".repeat(500)}</p>`,
    });

    expect(source).toContain("Content-Transfer-Encoding: base64");
    const body = source.split("\r\n\r\n")[1];
    for (const line of body.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it("adds the attachments as parts of a mixed message", () => {
    const source = buildImapDraftSource({
      ...base,
      attachments: [
        {
          filename: "notes.txt",
          contentType: "text/plain",
          content: Buffer.from("hello", "utf8"),
        },
      ],
    });

    expect(source).toContain("Content-Type: multipart/mixed; boundary=");
    expect(source).toContain(
      'Content-Disposition: attachment; filename="notes.txt"',
    );
    expect(source).toContain(Buffer.from("hello", "utf8").toString("base64"));
  });
});

describe("readImapDraftAttachments", () => {
  it("reads the files a draft carries", async () => {
    const source = buildImapDraftSource({
      from: { address: "owner@example.com" },
      to: [{ address: "someone@example.com" }],
      subject: "With a file",
      html: "<p>see attached</p>",
      messageId: "abc123@example.com",
      attachments: [
        {
          filename: "notes.txt",
          contentType: "text/plain",
          content: Buffer.from("hello", "utf8"),
        },
      ],
    });

    const attachments = await readImapDraftAttachments(Buffer.from(source));

    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("notes.txt");
    expect(attachments[0].content.toString("utf8")).toBe("hello");
  });

  it("reads nothing from a draft with no files", async () => {
    const source = buildImapDraftSource({
      from: { address: "owner@example.com" },
      to: [{ address: "someone@example.com" }],
      subject: "No file",
      html: "<p>nothing attached</p>",
      messageId: "abc123@example.com",
    });

    const attachments = await readImapDraftAttachments(Buffer.from(source));

    expect(attachments).toEqual([]);
  });
});

describe("createImapDraftMessageId", () => {
  it("makes an id in the mailbox's own domain", () => {
    const id = createImapDraftMessageId("owner@example.com");

    expect(id.endsWith("@owner@example.com")).toBe(true);
    expect(id).not.toContain("<");
  });

  it("makes a different id every time", () => {
    const first = createImapDraftMessageId("owner@example.com");
    const second = createImapDraftMessageId("owner@example.com");

    expect(first).not.toBe(second);
  });
});
