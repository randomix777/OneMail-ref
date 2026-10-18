import { nylasFetch, NYLAS_MAX_PAGE_SIZE } from "@/utils/nylas/client";
import { toParsedMessage, type NylasMessage } from "@/utils/nylas/message";

export type NylasListResponse<T> = {
  data?: T[];
  next_cursor?: string | null;
};

/**
 * The subset of documented list filters this app needs. `in` takes a folder id,
 * and `searchQueryNative` passes provider syntax through untouched (Gmail
 * operators for Google grants).
 */
export type NylasMessageQuery = {
  limit?: number;
  pageToken?: string;
  /** Folder or label id. */
  in?: string;
  unread?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  from?: string;
  to?: string;
  anyEmail?: string;
  subject?: string;
  threadId?: string;
  receivedAfter?: Date;
  receivedBefore?: Date;
  searchQueryNative?: string;
  /**
   * `include_basic_headers` is much smaller than `include_headers` and still
   * carries the three threading headers the reader needs.
   */
  fields?: "standard" | "include_basic_headers" | "include_headers";
};

export type NylasThread = {
  id: string;
  subject?: string | null;
  snippet?: string | null;
  message_ids?: string[] | null;
  last_message_timestamp?: number | null;
  unread?: boolean | null;
  starred?: boolean | null;
  folders?: string[] | null;
  participants?: Array<{ name?: string | null; email?: string | null }> | null;
};

export type NylasSendBody = {
  to: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  bcc?: Array<{ name?: string; email: string }>;
  from?: Array<{ name?: string; email: string }>;
  subject?: string;
  /** HTML unless `isPlaintext` is set. */
  body?: string;
  isPlaintext?: boolean;
  replyToMessageId?: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    /** Base64-encoded file content. */
    content: string;
    contentId?: string;
  }>;
};

export async function listNylasMessages({
  grantId,
  query = {},
}: {
  grantId: string;
  query?: NylasMessageQuery;
}) {
  const response = await nylasFetch<NylasListResponse<NylasMessage>>({
    path: `/grants/${grantId}/messages`,
    query: messageQueryParams(query),
  });

  return {
    messages: response.data ?? [],
    nextCursor: response.next_cursor ?? null,
  };
}

export async function getNylasMessage({
  grantId,
  messageId,
}: {
  grantId: string;
  messageId: string;
}) {
  const response = await nylasFetch<{ data?: NylasMessage }>({
    path: `/grants/${grantId}/messages/${encodeURIComponent(messageId)}`,
    query: { fields: "include_basic_headers" },
  });

  if (!response.data) return null;
  return toParsedMessage(response.data);
}

/**
 * Every message in a thread, in the order Nylas returns them. The documented
 * `thread_id` filter is far cheaper than walking the threads endpoint, which
 * Nylas warns is a common source of 429s.
 */
export async function listNylasThreadMessages({
  grantId,
  threadId,
  limit = NYLAS_MAX_PAGE_SIZE,
}: {
  grantId: string;
  threadId: string;
  limit?: number;
}) {
  const messages: NylasMessage[] = [];
  let pageToken: string | undefined;

  // A thread is bounded in practice, but cap the walk so a bad cursor cannot
  // spin forever.
  for (let page = 0; page < 10; page++) {
    const response = await listNylasMessages({
      grantId,
      query: { threadId, limit, pageToken },
    });
    messages.push(...response.messages);

    if (!response.nextCursor) break;
    pageToken = response.nextCursor;
  }

  return messages;
}

export async function listNylasThreads({
  grantId,
  query = {},
}: {
  grantId: string;
  query?: NylasMessageQuery;
}) {
  const response = await nylasFetch<NylasListResponse<NylasThread>>({
    path: `/grants/${grantId}/threads`,
    query: messageQueryParams(query),
  });

  return {
    threads: response.data ?? [],
    nextCursor: response.next_cursor ?? null,
  };
}

/**
 * Nylas replaces the folder membership it is given, so callers pass the full
 * set they want the message to end up in rather than a delta.
 */
export async function updateNylasMessage({
  grantId,
  messageId,
  folders,
  unread,
  starred,
}: {
  grantId: string;
  messageId: string;
  folders?: string[];
  unread?: boolean;
  starred?: boolean;
}) {
  await nylasFetch({
    path: `/grants/${grantId}/messages/${encodeURIComponent(messageId)}`,
    method: "PUT",
    body: {
      ...(folders ? { folders } : {}),
      ...(unread === undefined ? {} : { unread }),
      ...(starred === undefined ? {} : { starred }),
    },
  });
}

export async function deleteNylasMessage({
  grantId,
  messageId,
}: {
  grantId: string;
  messageId: string;
}) {
  await nylasFetch({
    path: `/grants/${grantId}/messages/${encodeURIComponent(messageId)}`,
    method: "DELETE",
  });
}

export async function sendNylasMessage({
  grantId,
  body,
}: {
  grantId: string;
  body: NylasSendBody;
}) {
  const response = await nylasFetch<{ data?: NylasMessage }>({
    path: `/grants/${grantId}/messages/send`,
    method: "POST",
    body: {
      to: body.to,
      ...(body.cc ? { cc: body.cc } : {}),
      ...(body.bcc ? { bcc: body.bcc } : {}),
      ...(body.from ? { from: body.from } : {}),
      ...(body.subject === undefined ? {} : { subject: body.subject }),
      ...(body.body === undefined ? {} : { body: body.body }),
      ...(body.isPlaintext ? { is_plaintext: true } : {}),
      ...(body.replyToMessageId
        ? { reply_to_message_id: body.replyToMessageId }
        : {}),
      ...(body.attachments
        ? {
            attachments: body.attachments.map((attachment) => ({
              filename: attachment.filename,
              content_type: attachment.contentType,
              content: attachment.content,
              ...(attachment.contentId
                ? { content_id: attachment.contentId }
                : {}),
            })),
          }
        : {}),
    },
  });

  if (!response.data?.id) {
    throw new Error("Nylas accepted the send but returned no message id");
  }

  return response.data;
}

function messageQueryParams(query: NylasMessageQuery) {
  return {
    limit: query.limit,
    page_token: query.pageToken,
    in: query.in,
    unread: query.unread,
    starred: query.starred,
    has_attachment: query.hasAttachment,
    from: query.from,
    to: query.to,
    any_email: query.anyEmail,
    subject: query.subject,
    thread_id: query.threadId,
    // Nylas takes Unix seconds.
    received_after: query.receivedAfter
      ? Math.floor(query.receivedAfter.getTime() / 1000)
      : undefined,
    received_before: query.receivedBefore
      ? Math.floor(query.receivedBefore.getTime() / 1000)
      : undefined,
    search_query_native: query.searchQueryNative,
    fields: query.fields,
  };
}
