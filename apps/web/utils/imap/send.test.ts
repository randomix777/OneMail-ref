import { describe, expect, it } from "vitest";
import {
  composeRawMessage,
  type OutgoingMessage,
  sentCopyBehaviour,
} from "@/utils/imap/send";

const base: OutgoingMessage = {
  from: "Ada <ada@example.com>",
  to: ["grace@example.com"],
  subject: "Design review",
  text: "Agenda attached.",
};

describe("sentCopyBehaviour", () => {
  it("treats the copy as ours for the providers that document nothing", () => {
    // Fastmail and Yahoo say nothing about the SMTP submission path; assuming the
    // provider files it would silently lose sent mail.
    expect(sentCopyBehaviour("fastmail")).toBe("client-files");
    expect(sentCopyBehaviour("yahoo")).toBe("client-files");
    expect(sentCopyBehaviour("imap")).toBe("client-files");
    expect(sentCopyBehaviour("icloud")).toBe("client-files");
  });

  it("knows Zoho files one itself, so we must not append a second", () => {
    // Documented: mail sent through smtp.zoho.com is saved to Sent automatically,
    // which a client that also APPENDs would duplicate.
    expect(sentCopyBehaviour("zoho")).toBe("provider-files");
  });
});

describe("composeRawMessage", () => {
  it("produces a message with the headers a server needs", async () => {
    const raw = (await composeRawMessage(base)).toString("utf8");

    expect(raw).toContain("From: Ada <ada@example.com>");
    expect(raw).toContain("To: grace@example.com");
    expect(raw).toContain("Subject: Design review");
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw).toContain("Agenda attached.");
  });

  it("sends both parts when there is HTML", async () => {
    const raw = (
      await composeRawMessage({
        ...base,
        html: "<p>Agenda attached.</p>",
      })
    ).toString("utf8");

    // The copy in Sent has to match what was delivered, so the composer's
    // multipart structure is the point rather than an implementation detail.
    expect(raw.toLowerCase()).toContain("multipart/alternative");
    expect(raw).toContain("<p>Agenda attached.</p>");
  });

  it("carries the threading headers on a reply", async () => {
    const raw = (
      await composeRawMessage({
        ...base,
        inReplyTo: "<original@example.com>",
        references: ["<root@example.com>", "<original@example.com>"],
      })
    ).toString("utf8");

    expect(raw).toContain("In-Reply-To: <original@example.com>");
    expect(raw).toContain(
      "References: <root@example.com> <original@example.com>",
    );
  });

  it("includes an attachment in the composed bytes", async () => {
    const raw = (
      await composeRawMessage({
        ...base,
        attachments: [
          {
            filename: "agenda.txt",
            content: "line one",
            contentType: "text/plain",
          },
        ],
      })
    ).toString("utf8");

    expect(raw).toContain("agenda.txt");
    // The body is base64 on the wire, not the literal text.
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(raw).toContain(Buffer.from("line one").toString("base64"));
  });

  it("encodes a non-ASCII subject rather than dropping it", async () => {
    const raw = (
      await composeRawMessage({ ...base, subject: "Résumé — design review" })
    ).toString("utf8");

    // Encoded-word form; the literal UTF-8 would not survive a 7-bit transport.
    expect(raw).toContain("Subject: =?UTF-8?");
  });

  it("uses CRLF line endings, which the wire format requires", async () => {
    const raw = (await composeRawMessage(base)).toString("utf8");

    expect(raw).toContain("\r\n");
  });
});
