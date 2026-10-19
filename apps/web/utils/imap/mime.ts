import PostalMime, { type Email as PostalMimeEmail } from "postal-mime";
import type { Attachment, ParsedMessage } from "@/utils/types";

/**
 * A message as IMAP reports it before any body is downloaded: ENVELOPE,
 * INTERNALDATE, RFC 5322 size and flags, keyed by UID.
 */
export type ImapMessageSummary = {
  uid: number;
  envelope?: {
    subject?: string | null;
    date?: Date | string | null;
    messageId?: string | null;
    inReplyTo?: string | null;
    from?: Array<{ name?: string | null; address?: string | null }> | null;
    to?: Array<{ name?: string | null; address?: string | null }> | null;
    cc?: Array<{ name?: string | null; address?: string | null }> | null;
    bcc?: Array<{ name?: string | null; address?: string | null }> | null;
  } | null;
  internalDate?: Date | string | null;
  size?: number;
  /** IMAP system flags, e.g. `\Seen`, `\Flagged`, `\Draft`, `\Deleted`, `\Answered`. */
  flags?: Set<string> | string[] | null;
  /** Our folder id for the mailbox this message came from. */
  folderId: string;
  /** Our label for that folder, when the folder has one. */
  labelIds?: string[];
};

/**
 * The IMAP flags that the app's model derives state from.
 *
 * Everything here maps onto the same conventions Gmail's `labelIds` carry
 * (`apps/web/utils/mail-api/observations.ts`), because read/starred/draft state
 * is read from those rather than from a provider-specific field:
 * `\Seen` → not unread, `\Flagged` → starred, `\Draft` → draft.
 */
export function imapFlagsToLabelIds({
  flags,
  folderId,
  labelIds = [],
}: {
  flags?: Set<string> | string[] | null;
  folderId: string;
  labelIds?: string[];
}) {
  const set = new Set(
    (Array.isArray(flags) ? flags : [...(flags ?? [])]).map((flag) =>
      String(flag).toLowerCase(),
    ),
  );

  const ids = new Set(labelIds);
  ids.add(folderId);

  if (set.has("\\seen")) ids.delete("UNREAD");
  else ids.add("UNREAD");

  if (set.has("\\flagged")) ids.add("STARRED");
  if (set.has("\\draft")) ids.add("DRAFT");
  if (set.has("\\answered")) ids.add("ANSWERED");

  return [...ids];
}

/**
 * Builds the message record the app reads, from an IMAP summary.
 *
 * The body is left empty on purpose: IMAP can report a message's existence
 * without transferring it, and hydration fetches the source separately for the
 * few messages that need it.
 */
export function toParsedMessage(
  summary: ImapMessageSummary,
  accountEmail: string,
): ParsedMessage {
  const envelope = summary.envelope ?? {};
  const internalDate = summary.internalDate
    ? new Date(summary.internalDate)
    : null;
  const date = envelope.date
    ? new Date(envelope.date)
    : (internalDate ?? new Date());

  const labelIds = imapFlagsToLabelIds({
    flags: summary.flags,
    folderId: summary.folderId,
    labelIds: summary.labelIds,
  });

  return {
    // The mailbox is part of the id because an IMAP UID is only unique inside one
    // mailbox; without it a move or a flag change could hit the wrong message.
    id: `${summary.folderId}:${summary.uid}`,
    // IMAP has no conversation object: the thread is the References/In-Reply-To
    // chain, which the caller resolves. Falling back to the message itself keeps
    // a message that starts a thread in a conversation of its own.
    threadId: envelope.messageId || `${summary.folderId}:${summary.uid}`,
    historyId: String(summary.uid),
    date: date.toISOString(),
    internalDate: internalDate?.toISOString() ?? null,
    subject: envelope.subject ?? "",
    snippet: "",
    textPlain: "",
    textHtml: "",
    headers: {
      date: date.toISOString(),
      from: formatAddresses(envelope.from) || accountEmail,
      to: formatAddresses(envelope.to),
      cc: formatAddresses(envelope.cc) || undefined,
      bcc: formatAddresses(envelope.bcc) || undefined,
      subject: envelope.subject ?? "",
      "message-id": envelope.messageId ?? undefined,
      "in-reply-to": envelope.inReplyTo ?? undefined,
    },
    labelIds,
    parentFolderId: summary.folderId,
    inline: [],
    attachments: [],
  };
}

function formatAddresses(
  addresses?: Array<{ name?: string | null; address?: string | null }> | null,
) {
  if (!addresses?.length) return "";

  return addresses
    .filter((entry) => entry.address)
    .map((entry) =>
      entry.name ? `${entry.name} <${entry.address}>` : `${entry.address}`,
    )
    .join(", ");
}

/**
 * Fills in the body, attachments and invitation content from a fetched source.
 *
 * `attachmentEncoding: "utf8"` keeps text parts as strings, which is what the
 * existing Outlook path uses; binary attachment contents are intentionally not
 * materialised here because fetching one is a separate call.
 */
export async function applyImapSource({
  message,
  source,
}: {
  message: ParsedMessage;
  source: Buffer | string;
}): Promise<ParsedMessage> {
  const mime = await PostalMime.parse(source, { attachmentEncoding: "utf8" });

  const attachments: Attachment[] = mime.attachments.map(
    (attachment, index) => ({
      attachmentId: `${message.id}-${index}`,
      filename: attachment.filename ?? "",
      mimeType: attachment.mimeType,
      size:
        typeof attachment.content === "string"
          ? attachment.content.length
          : attachment.content.byteLength,
      headers: {
        "content-description": attachment.description ?? "",
        "content-disposition": attachment.disposition ?? "",
        "content-id": attachment.contentId ?? "",
        // PostalMime reports how it decoded the part, not the transfer encoding
        // the sender used, so this stays empty the way the Nylas mapping does.
        "content-transfer-encoding": "",
        "content-type": attachment.mimeType,
      },
    }),
  );

  const headers = { ...message.headers, ...pickHeaders(mime) };

  return {
    ...message,
    headers,
    textPlain: mime.text ?? "",
    textHtml: mime.html ?? undefined,
    snippet: buildSnippet(mime.text ?? mime.html ?? ""),
    attachments,
    inline: [],
    hasAttachment: attachments.length > 0,
    calendarContent: findCalendarContent(mime),
    isMeetingInvitation: false,
  };
}

function pickHeaders(mime: PostalMimeEmail) {
  // PostalMime already exposes the threading headers as fields, so they are read
  // from there rather than hand-parsed out of `headers`.
  const listUnsubscribe = findHeader(mime, "list-unsubscribe");
  const listUnsubscribePost = findHeader(mime, "list-unsubscribe-post");

  return {
    "message-id": mime.messageId,
    "in-reply-to": mime.inReplyTo,
    references: mime.references,
    "reply-to": mime.replyTo?.[0]?.address,
    "list-unsubscribe": listUnsubscribe,
    "list-unsubscribe-post": listUnsubscribePost,
  };
}

function findHeader(mime: PostalMimeEmail, name: string) {
  const header = mime.headers.find((entry) => entry.key.toLowerCase() === name);
  return header?.value;
}

function findCalendarContent(mime: PostalMimeEmail) {
  const calendar = mime.attachments.find(
    (attachment) =>
      attachment.mimeType === "text/calendar" ||
      attachment.mimeType === "application/ics",
  );

  return typeof calendar?.content === "string" ? calendar.content : undefined;
}

/** One short line, the way a list row shows a preview. */
function buildSnippet(body: string) {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
