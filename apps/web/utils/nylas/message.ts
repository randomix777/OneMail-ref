import type { Attachment, ParsedMessage } from "@/utils/types";
import { formatEmailWithName } from "@/utils/email";

export type NylasParticipant = {
  name?: string | null;
  email?: string | null;
};

export type NylasAttachment = {
  id: string;
  filename?: string | null;
  content_type?: string | null;
  content_disposition?: string | null;
  content_id?: string | null;
  is_inline?: boolean | null;
  size?: number | null;
};

export type NylasHeader = { name: string; value: string };

export type NylasMessage = {
  id: string;
  thread_id?: string | null;
  subject?: string | null;
  from?: NylasParticipant[] | null;
  to?: NylasParticipant[] | null;
  cc?: NylasParticipant[] | null;
  bcc?: NylasParticipant[] | null;
  reply_to?: NylasParticipant[] | null;
  date?: number | null;
  snippet?: string | null;
  body?: string | null;
  folders?: string[] | null;
  unread?: boolean | null;
  starred?: boolean | null;
  attachments?: NylasAttachment[] | null;
  headers?: NylasHeader[] | null;
};

/**
 * The engine reads roles and flags out of Gmail-shaped label ids, and for Google
 * grants Nylas' folder ids *are* the Gmail label ids. `unread` and `starred` are
 * authoritative booleans, so they correct the folder list in both directions
 * rather than only adding.
 */
const UNREAD_LABEL = "UNREAD";
const STARRED_LABEL = "STARRED";

const DEFAULT_MIME_TYPE = "application/octet-stream";
const CALENDAR_MIME_HINTS = ["text/calendar", "application/ics"];
const MAX_VERSION_LENGTH = 256;

export function toParsedMessage(message: NylasMessage): ParsedMessage {
  const dateMs = toDateMs(message.date);
  const labelIds = labelIdsFromMessage(message);
  const attachments = message.attachments ?? [];
  const inline = attachments.filter(isInlineAttachment).map(toAttachment);

  return {
    id: message.id,
    threadId: message.thread_id ?? message.id,
    historyId: versionOfMessage(message, labelIds),
    date: new Date(dateMs).toISOString(),
    // Gmail reports internalDate in milliseconds; the engine scales seconds up
    // on its own, so milliseconds is the safe unit here.
    internalDate: String(dateMs),
    subject: message.subject ?? "",
    snippet: message.snippet ?? "",
    labelIds,
    headers: headersFor(message, dateMs),
    attachments: attachments
      .filter((a) => !isInlineAttachment(a))
      .map(toAttachment),
    inline,
    hasAttachment: attachments.length > 0,
    isMeetingInvitation: isMeetingInvitation(message),
    ...bodyFields(message.body ?? ""),
  };
}

function headersFor(
  message: NylasMessage,
  dateMs: number,
): ParsedMessage["headers"] {
  const headers = headerMapFrom(message.headers);
  const replyTo = formatParticipants(message.reply_to);

  return {
    from: formatParticipants(message.from),
    to: formatParticipants(message.to),
    cc: formatParticipants(message.cc),
    bcc: formatParticipants(message.bcc),
    subject: message.subject ?? headers.get("subject") ?? "",
    date: new Date(dateMs).toISOString(),
    // Nylas only returns headers when asked, so threading falls back to whatever
    // the request asked for and is simply absent otherwise.
    "message-id": headers.get("message-id"),
    "in-reply-to": headers.get("in-reply-to"),
    references: headers.get("references"),
    "reply-to": replyTo || headers.get("reply-to"),
    "list-unsubscribe": headers.get("list-unsubscribe"),
    "list-unsubscribe-post": headers.get("list-unsubscribe-post"),
  };
}

function labelIdsFromMessage(message: NylasMessage): string[] {
  const labels = new Set(message.folders ?? []);
  setFlag(labels, UNREAD_LABEL, message.unread);
  setFlag(labels, STARRED_LABEL, message.starred);
  return [...labels];
}

function setFlag(
  labels: Set<string>,
  flag: string,
  value: boolean | null | undefined,
) {
  if (value === true) labels.add(flag);
  else if (value === false) labels.delete(flag);
}

function formatParticipants(
  participants: NylasParticipant[] | null | undefined,
): string {
  return (participants ?? [])
    .map((participant) =>
      formatEmailWithName(participant.name, participant.email),
    )
    .filter(Boolean)
    .join(", ");
}

/**
 * Nylas returns one `body` field holding HTML when both parts exist, so the
 * format has to be inferred. Plain-text bodies that merely contain markup are
 * treated as HTML, which is the safe direction: the engine renders HTML and can
 * derive text from it.
 */
function bodyFields(
  body: string,
): Pick<ParsedMessage, "bodyContentType" | "textHtml" | "textPlain"> {
  if (!body) return {};

  return looksLikeHtml(body)
    ? { bodyContentType: "html", textHtml: body }
    : { bodyContentType: "text", textPlain: body };
}

function looksLikeHtml(value: string) {
  return /<[a-z!/][\s\S]*>/i.test(value);
}

/**
 * An attachment is inline when the provider says so, and a `content_id` is the
 * other strong signal because that is what `cid:` references in the body resolve
 * against.
 */
function isInlineAttachment(attachment: NylasAttachment) {
  return attachment.is_inline === true || Boolean(attachment.content_id);
}

function toAttachment(attachment: NylasAttachment): Attachment {
  const mimeType = attachment.content_type || DEFAULT_MIME_TYPE;

  return {
    attachmentId: attachment.id,
    filename: attachment.filename ?? "",
    mimeType,
    size: attachment.size ?? 0,
    headers: {
      "content-description": "",
      "content-disposition": attachment.content_disposition ?? "",
      "content-id": attachment.content_id ?? "",
      "content-transfer-encoding": "",
      "content-type": mimeType,
    },
  };
}

function isMeetingInvitation(message: NylasMessage) {
  const hasCalendarAttachment = (message.attachments ?? []).some(
    (attachment) => {
      const contentType = attachment.content_type?.toLowerCase() ?? "";
      return CALENDAR_MIME_HINTS.some((hint) => contentType.includes(hint));
    },
  );

  return (
    hasCalendarAttachment || (message.body ?? "").includes("BEGIN:VCALENDAR")
  );
}

function toDateMs(date: number | null | undefined) {
  if (typeof date !== "number" || !Number.isFinite(date)) return 0;
  // Nylas dates are Unix seconds.
  return date * 1000;
}

/**
 * Nylas messages carry no version field, so the sync reference derives one from
 * the fields the engine stores. It changes exactly when observable metadata
 * changes, and stays bounded so it cannot bloat a sync page.
 */
function versionOfMessage(message: NylasMessage, labelIds: string[]) {
  const signature = [
    message.id,
    message.date ?? 0,
    message.unread === true ? "u" : "",
    message.starred === true ? "s" : "",
    message.subject ?? "",
    ...[...labelIds].sort(),
  ].join("|");

  return signature.slice(0, MAX_VERSION_LENGTH);
}

function headerMapFrom(headers: NylasHeader[] | null | undefined) {
  const map = new Map<string, string>();

  for (const header of headers ?? []) {
    const name = header.name?.toLowerCase();
    // Nylas does not merge repeated headers; the first non-empty value wins.
    if (!name || !header.value || map.has(name)) continue;
    map.set(name, header.value);
  }

  return map;
}
