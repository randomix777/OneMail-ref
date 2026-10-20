import { randomBytes } from "node:crypto";
import PostalMime from "postal-mime";
import type { ImapFlow } from "imapflow";

/**
 * Drafts over IMAP.
 *
 * IMAP has no draft API: a draft is an ordinary message in the Drafts
 * mailbox, so everything here reads, writes and removes messages by hand. Two
 * consequences shape the code:
 *
 * - A draft cannot be edited in place. Changing one means appending a new
 *   message and removing the old, so a rewritten draft keeps its Message-ID
 *   and the user sees one copy rather than two.
 * - The Message-ID is the draft's identity. The UID the server hands out
 *   changes with every rewrite, and the app holds the draft id across edits, so
 *   the id has to be something the rewrite does not change.
 */

/** The flag a draft carries in the Drafts mailbox. */
export const IMAP_DRAFT_FLAG = "\\Draft";

export type ImapDraftAddress = {
  address: string;
  name?: string;
};

export type ImapDraftAttachment = {
  filename: string;
  contentType?: string;
  content: Buffer;
  /**
   * The part's `Content-ID`, without the angle brackets.
   *
   * It is the attachment's identity: the UID changes with every rewrite, but a
   * Content-ID is carried over, so the file the user added is still the file
   * the app asks to remove later.
   */
  contentId?: string;
};

export type ImapDraftContent = {
  from: ImapDraftAddress;
  to: ImapDraftAddress[];
  cc?: ImapDraftAddress[];
  bcc?: ImapDraftAddress[];
  subject: string;
  html: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: ImapDraftAttachment[];
};

/**
 * A Message-ID for a new draft.
 *
 * The domain is the mailbox's own, so a client that groups drafts by domain
 * keeps them together.
 */
export function createImapDraftMessageId(domain: string): string {
  return `${randomBytes(12).toString("hex")}@${domain}`;
}

/**
 * Builds the RFC 5322 source of a draft.
 *
 * The body is sent as `text/html` because that is what the compose form holds.
 * A mail client that cannot render HTML still shows the source, so the plain
 * text alternative is derived from the same markup rather than dropped.
 */
export function buildImapDraftSource(content: ImapDraftContent): string {
  const headers = [
    `From: ${formatAddress(content.from)}`,
    `To: ${content.to.map(formatAddress).join(", ")}`,
    ...(content.cc?.length
      ? [`Cc: ${content.cc.map(formatAddress).join(", ")}`]
      : []),
    ...(content.bcc?.length
      ? [`Bcc: ${content.bcc.map(formatAddress).join(", ")}`]
      : []),
    `Subject: ${encodeHeaderValue(content.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${content.messageId}>`,
    ...(content.inReplyTo ? [`In-Reply-To: <${content.inReplyTo}>`] : []),
    ...(content.references?.length
      ? [
          `References: ${content.references
            .map((reference) => `<${reference}>`)
            .join(" ")}`,
        ]
      : []),
    "MIME-Version: 1.0",
  ];

  const attachments = content.attachments ?? [];

  if (!attachments.length) {
    return [
      ...headers,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(content.html, "utf8")),
    ].join("\r\n");
  }

  const boundary = `----=_OneMailDraft_${randomBytes(12).toString("hex")}`;

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(content.html, "utf8")),
    ...attachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${attachment.contentType ?? "application/octet-stream"}; name="${encodeParameterValue(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodeParameterValue(attachment.filename)}"`,
      ...(attachment.contentId
        ? [`Content-ID: <${attachment.contentId}>`]
        : []),
      "",
      wrapBase64(attachment.content),
    ]),
    `--${boundary}--`,
  ].join("\r\n");
}

/**
 * The attachments already on a draft, read from its source.
 *
 * A draft the user created in another client can carry files, and rewriting
 * the text of such a draft must not drop them.
 */
export async function readImapDraftAttachments(source: Buffer) {
  const mime = await PostalMime.parse(source, {
    attachmentEncoding: "arraybuffer",
  });

  return mime.attachments.map((attachment) => ({
    filename: attachment.filename ?? "attachment",
    contentType: attachment.mimeType,
    content: Buffer.from(
      attachment.content instanceof ArrayBuffer
        ? new Uint8Array(attachment.content)
        : typeof attachment.content === "string"
          ? Buffer.from(attachment.content, "base64")
          : attachment.content,
    ),
    contentId: attachment.contentId
      ? stripMessageIdBrackets(attachment.contentId)
      : undefined,
  }));
}

/** A Message-ID without the angle brackets the header carries it in. */
function stripMessageIdBrackets(value: string) {
  return value.replace(/^</, "").replace(/>$/, "");
}

/**
 * The UID of the draft with this Message-ID, or null when there is none.
 *
 * The search is the server's own, so it does not depend on the draft folder
 * being small. A server that will not search by header falls back to reading
 * the most recent drafts, because a draft that cannot be found would leave the
 * user editing a copy the mailbox does not have.
 */
export async function findImapDraftUid({
  client,
  folderId,
  messageId,
}: {
  client: ImapFlow;
  folderId: string;
  messageId: string;
}): Promise<number | null> {
  const lock = await client.getMailboxLock(folderId);

  try {
    const uids = await client.search(
      { header: { "message-id": `<${messageId}>` } },
      { uid: true },
    );

    if (Array.isArray(uids) && uids.length) return uids[uids.length - 1];

    const recent = await client.fetch(
      { uid: "1:*" },
      { uid: true, envelope: true },
    );

    for await (const message of recent) {
      if (message.envelope?.messageId === `<${messageId}>`) return message.uid;
    }

    return null;
  } finally {
    lock.release();
  }
}

/** Appends a draft to the Drafts mailbox. */
export async function appendImapDraft({
  client,
  folderId,
  source,
}: {
  client: ImapFlow;
  folderId: string;
  source: string;
}) {
  const lock = await client.getMailboxLock(folderId);

  try {
    await client.append(folderId, source, [IMAP_DRAFT_FLAG]);
  } finally {
    lock.release();
  }
}

function formatAddress(address: ImapDraftAddress) {
  if (!address.name) return address.address;
  return `${encodeHeaderValue(address.name)} <${address.address}>`;
}

/**
 * RFC 2047 encoding for a header that is not plain ASCII.
 *
 * A subject or display name in another script has to be encoded, or the server
 * stores a header it cannot read back.
 */
function encodeHeaderValue(value: string) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** A MIME parameter value, quoted and stripped of the characters that end it. */
function encodeParameterValue(value: string) {
  return value.replace(/[\\"]/g, "");
}

/**
 * Base64 in the line lengths the MIME specification asks for.
 *
 * A long base64 line is legal to read but not to parse, and some clients
 * refuse the message instead of wrapping it themselves.
 */
function wrapBase64(content: Buffer) {
  return content
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n")
    .trim();
}
