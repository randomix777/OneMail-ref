import chunk from "lodash/chunk";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import { mapWithConcurrency } from "@/utils/async";
import { splitRecipientList } from "@/utils/email";
import type {
  BulkArchiveResult,
  BulkArchiveThread,
  DraftAttachmentUploadStart,
  DraftAttachmentsResult,
  DraftReference,
  EmailContact,
  EmailFilter,
  EmailFolderCount,
  EmailLabel,
  EmailLabelUpdate,
  EmailProvider,
  EmailSignature,
  EmailThread,
  GetThreadOptions,
  MailboxSyncPage,
  ProviderMailboxSearch,
  SendAsAddress,
  SendEmailOptions,
  SentMessagePage,
} from "@/utils/email/types";
import type { DraftAttachmentMetadata } from "@/utils/actions/draft-attachments.validation";
import { createScopedLogger, type Logger } from "@/utils/logger";
import { SafeError } from "@/utils/error";
import type { InboxZeroLabel } from "@/utils/label";
import { inboxZeroLabels } from "@/utils/label";
import type { SendEmailBody } from "@/utils/types/mail";
import type { ParsedMessage } from "@/utils/types";
import type { ThreadsQuery } from "@/utils/threads/validation";
import {
  isNylasErrorWithStatus,
  NYLAS_MAX_PAGE_SIZE,
  nylasFetch,
} from "@/utils/nylas/client";
import {
  getNylasMessage,
  listNylasMessages,
  listNylasThreadMessages,
  listNylasThreads,
  sendNylasMessage,
  updateNylasMessage,
  type NylasThread,
} from "@/utils/nylas/mail";
import {
  findFolderIdByRole,
  listNylasFolders,
  roleOfFolder,
  toOutlookFolder,
  type NylasFolder,
} from "@/utils/nylas/folder";
import {
  listNylasContactPhotos,
  searchNylasContacts,
} from "@/utils/nylas/contacts";
import { toParsedMessage } from "@/utils/nylas/message";
import {
  decodeMailboxSyncCursor,
  encodeMailboxSyncCursor,
} from "@/utils/email/mailbox-sync";
import type {
  OutlookFolder,
  OutlookSystemFolder,
} from "@/utils/outlook/folders";

/**
 * Nylas delta is a time window, not a provider change log, so each read asks for
 * everything received since the cursor. Two minutes of overlap absorbs clock
 * skew between our clock and the mail server's; re-delivered messages are
 * idempotent patches, so a duplicate costs a little bandwidth and nothing else.
 */
const DELTA_OVERLAP_MS = 2 * 60 * 1000;
const DELTA_PAGE_SIZE = 100;

/** Read-modify-write mutations fan out per message; keep well inside Nylas limits. */
const MUTATION_CONCURRENCY = 4;

/** Nylas caps a whole JSON request body at 3 MB when attachments are inline. */
const MAX_INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const GMAIL_FLAG_LABELS = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
} as const;

/**
 * Features Nylas has no API for. They throw instead of returning a plausible
 * empty result, so a caller cannot mistake "not supported" for "nothing to do".
 *
 * A `SafeError` because these are expected limits of a Nylas connection, not
 * faults: the server-action layer shows the message to the user and keeps the
 * error out of Sentry, where an unexpected error would be reported and the user
 * would only be told that something went wrong.
 */
export class NylasUnsupportedFeatureError extends SafeError {
  constructor(feature: string) {
    super(`Nylas does not support ${feature} for Google mailboxes`);
    this.name = "NylasUnsupportedFeatureError";
  }
}

/**
 * Google mail over Nylas.
 *
 * The account's family stays `google` (so terminology, roles, and error copy are
 * unchanged) while the transport is `nylas`. Nylas holds and refreshes the
 * user's Google tokens, so every call here authenticates with our application
 * API key and the mailbox's grant id.
 *
 * Nylas exposes folders and labels through one API. For Google grants the folder
 * ids are Gmail's label ids, which is what lets `labelIds` keep carrying roles
 * (`INBOX`, `SENT`, `UNREAD`, `STARRED`, `CATEGORY_*`) exactly as Gmail does.
 */
export class NylasMailProvider implements EmailProvider {
  readonly name = "google";
  readonly localMailSyncStrategy = "account-history";
  private readonly grantId: string;
  private readonly emailAccountId: string;
  private readonly logger: Logger;
  private foldersPromise?: Promise<NylasFolder[]>;

  constructor({
    grantId,
    emailAccountId,
    logger,
  }: {
    grantId: string;
    emailAccountId: string;
    logger?: Logger;
  }) {
    this.grantId = grantId;
    this.emailAccountId = emailAccountId;
    this.logger = (logger || createScopedLogger("nylas-provider")).with({
      emailAccountId: this.emailAccountId,
      provider: "google",
      transport: "nylas",
    });
  }

  toJSON() {
    return { name: this.name, type: "NylasMailProvider" };
  }

  /**
   * Nylas owns the provider tokens; there is no per-account access token to
   * expose. Callers use this for logging and for the (unsupported) draft upload
   * proxy, so an empty value is correct rather than misleading.
   */
  getAccessToken(): string {
    return "";
  }

  // ---------------------------------------------------------------- sync + reads

  async getMailboxSyncPage(options: {
    after?: Date;
    cursor?: string;
    folderId?: string;
    limit: number;
  }): Promise<MailboxSyncPage> {
    const limit = Math.min(options.limit, DELTA_PAGE_SIZE);
    const cursor = options.cursor
      ? decodeMailboxSyncCursor(options.cursor, "nylas")
      : null;

    if (!cursor) {
      // First read: start the window and hand back a cursor immediately, so a
      // bootstrap does not have to guess how far back to page.
      const after = (
        options.after ?? new Date(Date.now() - DELTA_OVERLAP_MS)
      ).toISOString();
      return {
        cursor: encodeMailboxSyncCursor({
          version: 1,
          provider: "nylas",
          after,
        }),
        upsertedMessages: [],
        deletedMessageIds: [],
        hasMore: false,
        reset: false,
      };
    }

    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit,
        pageToken: cursor.pageToken,
        in: options.folderId,
        receivedAfter: shiftBack(cursor.after),
        fields: "include_basic_headers",
      },
    });

    const messages = result.messages.map(toParsedMessage);
    const nextPageToken = result.nextCursor ?? undefined;

    return {
      cursor: encodeMailboxSyncCursor({
        version: 1,
        provider: "nylas",
        after: nextPageToken
          ? cursor.after
          : (newestTimestamp(messages) ?? cursor.after),
        pageToken: nextPageToken,
      }),
      upsertedMessages: messages,
      // Nylas exposes no deletion feed, so removals surface through the window
      // being re-read rather than being reported here.
      deletedMessageIds: [],
      hasMore: Boolean(nextPageToken),
      reset: false,
    };
  }

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    folderId?: string;
    before?: Date;
    after?: Date;
    inboxOnly?: boolean;
    unreadOnly?: boolean;
    includeDrafts?: boolean;
  }) {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: options.maxResults ?? NYLAS_MAX_PAGE_SIZE,
        pageToken: options.pageToken,
        in: options.inboxOnly ? await this.folderId("INBOX") : options.folderId,
        unread: options.unreadOnly || undefined,
        receivedAfter: options.after,
        receivedBefore: options.before,
        searchQueryNative: options.query || undefined,
        fields: "include_basic_headers",
      },
    });

    return {
      messages: result.messages.map(toParsedMessage),
      nextPageToken: result.nextCursor ?? undefined,
    };
  }

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const message = await getNylasMessage({
      grantId: this.grantId,
      messageId,
    });

    if (!message) throw notFound(`Message ${messageId} was not found`);
    return message;
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    const messages = await mapWithConcurrency(messageIds, 5, (messageId) =>
      this.getMessage(messageId),
    );
    return messages;
  }

  async getThread(
    threadId: string,
    options?: GetThreadOptions,
  ): Promise<EmailThread> {
    const messages = await this.threadMessages(threadId);

    const visible = options?.includeDrafts
      ? messages
      : messages.filter((message) => !isDraft(message));

    return {
      id: threadId,
      messages: sortedByDate(visible),
      snippet: visible.at(-1)?.snippet ?? "",
    };
  }

  async getThreadMessages(threadId: string): Promise<ParsedMessage[]> {
    return sortedByDate(await this.threadMessages(threadId));
  }

  async getThreadMessagesInInbox(threadId: string): Promise<ParsedMessage[]> {
    const messages = await this.threadMessages(threadId);
    return messages.filter((message) =>
      hasLabel(message, GMAIL_FLAG_LABELS.inbox),
    );
  }

  async getLatestMessageInThread(
    threadId: string,
  ): Promise<ParsedMessage | null> {
    const messages = sortedByDate(await this.threadMessages(threadId));
    return messages.at(-1) ?? null;
  }

  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ): Promise<ParsedMessage | null> {
    return sortedByDate(thread.messages).at(-1) ?? null;
  }

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;
    return this.findMessage(originalMessageId);
  }

  async getPreviousConversationMessages(
    messageIds: string[],
  ): Promise<ParsedMessage[]> {
    const messages = await this.getMessagesBatch(messageIds);
    return sortedByDate(messages);
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: 5,
        // Nylas passes this to Gmail untouched, so the Gmail operator applies.
        searchQueryNative: `rfc822msgid:${stripAngleBrackets(rfc822MessageId)}`,
        fields: "include_basic_headers",
      },
    });

    const match = result.messages.find(
      (message) =>
        stripAngleBrackets(
          message.headers?.find(
            (header) => header.name.toLowerCase() === "message-id",
          )?.value ?? "",
        ) === stripAngleBrackets(rfc822MessageId),
    );

    return match ? toParsedMessage(match) : null;
  }

  async searchMessages(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    fromEmail?: string;
    readState?: "read" | "unread";
    labelName?: string;
    folderId?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
    folder?: "spam" | "trash";
    mailboxSearch?: ProviderMailboxSearch;
  }) {
    const scoped = await this.scopeFromMailboxSearch(options.mailboxSearch);
    // Gmail omits spam and trash unless asked; Nylas forwards the query as-is so
    // the same rule applies through `in`.
    const folderId =
      options.folderId ??
      scoped.folderId ??
      (options.folder === "spam"
        ? await this.folderId("SPAM")
        : options.folder === "trash"
          ? await this.folderId("TRASH")
          : options.labelIds?.length === 1
            ? await this.labelFolderId(options.labelIds[0])
            : undefined);

    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: options.maxResults ?? NYLAS_MAX_PAGE_SIZE,
        pageToken: options.pageToken,
        in: folderId,
        unread: scoped.unread ?? unreadFromReadState(options.readState),
        starred: scoped.starred,
        hasAttachment: scoped.hasAttachment,
        from: options.fromEmail,
        searchQueryNative: buildNativeSearch(
          options.query,
          options.labelName,
          scoped.text,
        ),
        fields: "include_basic_headers",
      },
    });

    return {
      messages: result.messages.map(toParsedMessage),
      nextPageToken: result.nextCursor ?? undefined,
    };
  }

  async searchThreads(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    messageFormat?: "full" | "metadata";
    includeSpamTrash?: boolean;
    folder?: "spam" | "trash";
    labelIds?: string[];
  }) {
    const folderId =
      options.folder === "spam"
        ? await this.folderId("SPAM")
        : options.folder === "trash"
          ? await this.folderId("TRASH")
          : undefined;

    const result = await listNylasThreads({
      grantId: this.grantId,
      query: {
        limit: options.maxResults ?? NYLAS_MAX_PAGE_SIZE,
        pageToken: options.pageToken,
        in: folderId,
        searchQueryNative: options.query || undefined,
      },
    });

    const threads = await mapWithConcurrency(
      result.threads,
      4,
      async (thread) => this.threadFromSummary(thread),
    );

    return { threads, nextPageToken: result.nextCursor ?? undefined };
  }

  async getThreads(folderId?: string): Promise<EmailThread[]> {
    if (!folderId) {
      const { threads } = await this.getThreadsWithQuery({ maxResults: 50 });
      return threads;
    }

    const { threads } = await this.getThreadsWithQuery({
      query: { labelId: folderId },
      maxResults: 50,
    });
    return threads;
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
    messageFormat?: "full" | "metadata";
  }) {
    const query = options.query;
    const requestedLabels =
      query?.labelIds ?? (query?.labelId ? [query.labelId] : []);

    // Nylas filters by one folder per request, so additional labels are applied
    // to the result instead of the query.
    const folderId =
      query?.folderId ??
      (requestedLabels.length > 0
        ? await this.labelFolderId(requestedLabels[0])
        : undefined);

    const result = await listNylasThreads({
      grantId: this.grantId,
      query: {
        limit: options.maxResults ?? query?.limit ?? NYLAS_MAX_PAGE_SIZE,
        pageToken: options.pageToken ?? query?.nextPageToken ?? undefined,
        in: folderId,
        from: query?.fromEmail ?? undefined,
        unread: query?.isUnread ? true : undefined,
        receivedAfter: query?.after ?? undefined,
        receivedBefore: query?.before ?? undefined,
        searchQueryNative: query?.q || undefined,
      },
    });

    const threads = await mapWithConcurrency(
      result.threads,
      4,
      async (thread) => this.threadFromSummary(thread),
    );

    return {
      threads:
        requestedLabels.length > 1
          ? threads.filter((thread) =>
              thread.messages.some((message) =>
                requestedLabels.every((labelId) =>
                  (message.labelIds ?? []).includes(labelId),
                ),
              ),
            )
          : threads,
      nextPageToken: result.nextCursor ?? undefined,
    };
  }

  async getThreadsWithLabel(options: {
    labelId: string;
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const { threads } = await this.getThreadsWithQuery({
      query: { labelId: options.labelId },
      maxResults: options.maxResults,
    });
    return threads;
  }

  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }): Promise<EmailThread[]> {
    const { threads } = await this.getThreadsWithQuery({
      query: { fromEmail: options.participantEmail },
      maxResults: options.maxThreads,
    });
    return threads;
  }

  async getThreadsFromSenderWithSubject(
    sender: string,
    limit: number,
  ): Promise<Array<{ id: string; snippet: string; subject: string }>> {
    const { threads } = await this.getThreadsWithQuery({
      query: { fromEmail: sender },
      maxResults: limit,
      messageFormat: "metadata",
    });

    return threads.map((thread) => ({
      id: thread.id,
      snippet: thread.snippet,
      subject: thread.messages[0]?.subject ?? "",
    }));
  }

  async getSentThreadsExcluding(options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const { threads } = await this.getThreadsWithQuery({
      query: { labelId: await this.folderId("SENT") },
      maxResults: options.maxResults,
    });

    const excludedTo = new Set(
      (options.excludeToEmails ?? []).map((email) => email.toLowerCase()),
    );
    const excludedFrom = (options.excludeFromEmails ?? []).map((email) =>
      email.toLowerCase(),
    );
    if (excludedTo.size === 0 && excludedFrom.length === 0) return threads;

    return threads.filter((thread) => {
      const recipients = splitRecipientList(
        thread.messages[0]?.headers.to ?? "",
      ).map((value) => value.toLowerCase());
      const sender = (thread.messages[0]?.headers.from ?? "").toLowerCase();

      return (
        !recipients.some((value) => excludedTo.has(value)) &&
        !excludedFrom.some((value) => sender.includes(value))
      );
    });
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }) {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: options.maxResults ?? NYLAS_MAX_PAGE_SIZE,
        pageToken: options.pageToken,
        from: options.senderEmail,
        receivedBefore: options.before,
        receivedAfter: options.after,
        fields: "include_basic_headers",
      },
    });

    return {
      messages: result.messages.map(toParsedMessage),
      nextPageToken: result.nextCursor ?? undefined,
    };
  }

  async getMessagesWithAttachments(options: {
    maxResults?: number;
    pageToken?: string;
  }) {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: options.maxResults ?? NYLAS_MAX_PAGE_SIZE,
        pageToken: options.pageToken,
        hasAttachment: true,
      },
    });

    return {
      messages: result.messages.map(toParsedMessage),
      nextPageToken: result.nextCursor ?? undefined,
    };
  }

  async getSentMessages(maxResults?: number): Promise<ParsedMessage[]> {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: maxResults ?? NYLAS_MAX_PAGE_SIZE,
        in: await this.folderId("SENT"),
      },
    });
    return result.messages.map(toParsedMessage);
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
    pageToken?: string;
  }): Promise<SentMessagePage> {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: options.maxResults,
        pageToken: options.pageToken,
        in: await this.folderId("SENT"),
        receivedAfter: options.after,
        receivedBefore: options.before,
      },
    });

    return {
      messages: result.messages.map((message) => ({
        id: message.id,
        threadId: message.thread_id ?? message.id,
      })),
      nextPageToken: result.nextCursor ?? undefined,
    };
  }

  async getInboxMessages(maxResults?: number): Promise<ParsedMessage[]> {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: maxResults ?? NYLAS_MAX_PAGE_SIZE,
        in: await this.folderId("INBOX"),
      },
    });
    return result.messages.map(toParsedMessage);
  }

  async getInboxStats(): Promise<{ total: number; unread: number }> {
    const inbox = (await this.folders()).find(
      (folder) => roleOfFolder(folder) === "INBOX",
    );

    return {
      total: inbox?.total_count ?? 0,
      unread: inbox?.unread_count ?? 0,
    };
  }

  async getDrafts(options?: { maxResults?: number }): Promise<ParsedMessage[]> {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        limit: options?.maxResults ?? NYLAS_MAX_PAGE_SIZE,
        in: await this.folderId("DRAFT"),
      },
    });
    return result.messages.map(toParsedMessage);
  }

  async getDraft(
    draftId: string,
    options?: { includeAttachments?: boolean },
  ): Promise<ParsedMessage | null> {
    // Nylas drafts are messages in the drafts folder, so a draft is read the
    // same way as any other message — but a message that has left the drafts
    // folder (it was sent) is not a draft any more, and the id keeps resolving
    // to the delivered message. Reporting it as a draft would tell a caller the
    // draft still exists.
    const message = await getNylasMessage({
      grantId: this.grantId,
      messageId: draftId,
    });
    if (!message || !isDraft(message)) return null;
    if (options?.includeAttachments === false) {
      return { ...message, attachments: undefined, inline: [] };
    }
    return message;
  }

  async getDraftReferenceForMessage(
    messageId: string,
  ): Promise<DraftReference | null> {
    const message = await this.findMessage(messageId);
    if (!message || !isDraft(message)) return null;
    return { id: message.id };
  }

  async countMessages(options: {
    folderId?: string;
    labelId?: string;
  }): Promise<number> {
    const folderId = options.folderId ?? options.labelId;
    if (!folderId) return 0;

    const folder = (await this.folders()).find(
      (candidate) => candidate.id === folderId,
    );
    return folder?.total_count ?? 0;
  }

  async countReceivedMessages(
    senderEmail: string,
    threshold: number,
  ): Promise<number> {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: { from: senderEmail, limit: Math.min(threshold, 50) },
    });

    return Math.min(result.messages.length, threshold);
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }): Promise<boolean> {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        anyEmail: options.from,
        receivedBefore: options.date,
        limit: 1,
      },
    });

    return result.messages.some((message) => message.id !== options.messageId);
  }

  async checkIfReplySent(senderEmail: string): Promise<boolean> {
    const result = await listNylasMessages({
      grantId: this.grantId,
      query: {
        to: senderEmail,
        in: await this.folderId("SENT"),
        limit: 1,
      },
    });

    return result.messages.length > 0;
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    const response = await nylasFetch<{
      data?: string | { content?: string; size?: number };
    }>({
      path: `/grants/${this.grantId}/attachments/${encodeURIComponent(
        attachmentId,
      )}`,
      query: { message_id: messageId },
    });

    const payload = response.data;
    const base64 = typeof payload === "string" ? payload : payload?.content;
    if (!base64) throw notFound(`Attachment ${attachmentId} has no content`);

    return {
      data: base64,
      size: typeof payload === "object" ? (payload?.size ?? 0) : 0,
    };
  }

  async getAttachmentStream(
    messageId: string,
    attachmentId: string,
    _signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    // Nylas returns attachment bytes as JSON-encoded content rather than a
    // binary stream, so the stream is layered over the decoded payload.
    const { data } = await this.getAttachment(messageId, attachmentId);
    const bytes = Buffer.from(data, "base64");

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
  }

  // ---------------------------------------------------------------- labels + folders

  async getLabels(_options?: {
    includeHidden?: boolean;
  }): Promise<EmailLabel[]> {
    // Nylas does not report a label's list visibility, so Gmail's hidden labels
    // come back with the rest rather than being filtered out.
    const folders = await this.folders();
    return folders.map(toEmailLabel);
  }

  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    const folders = await this.folders();
    const folder = folders.find((candidate) => candidate.id === labelId);
    return folder ? toEmailLabel(folder) : null;
  }

  async getLabelByName(name: string): Promise<EmailLabel | null> {
    const folders = await this.folders();
    const folder = folders.find(
      (candidate) => (candidate.name ?? candidate.id) === name,
    );
    return folder ? toEmailLabel(folder) : null;
  }

  async getOrCreateInboxZeroLabel(key: InboxZeroLabel): Promise<EmailLabel> {
    const name = inboxZeroLabels[key].name;
    const existing = await this.getLabelByName(name);
    if (existing) return existing;
    return this.createLabel(name);
  }

  async createLabel(name: string, _description?: string): Promise<EmailLabel> {
    const response = await nylasFetch<{ data?: NylasFolder }>({
      path: `/grants/${this.grantId}/folders`,
      method: "POST",
      body: { name },
    });

    if (!response.data?.id) {
      throw new Error(`Nylas created no label for "${name}"`);
    }

    this.foldersPromise = undefined;
    return toEmailLabel(response.data);
  }

  async updateLabel(labelId: string, update: EmailLabelUpdate): Promise<void> {
    await nylasFetch({
      path: `/grants/${this.grantId}/folders/${encodeURIComponent(labelId)}`,
      method: "PUT",
      body: {
        ...(update.name === undefined ? {} : { name: update.name }),
        ...(update.color?.backgroundColor
          ? { background_color: update.color.backgroundColor }
          : {}),
        ...(update.color?.textColor
          ? { text_color: update.color.textColor }
          : {}),
      },
    });

    this.foldersPromise = undefined;
  }

  async deleteLabel(labelId: string): Promise<void> {
    try {
      await nylasFetch({
        path: `/grants/${this.grantId}/folders/${encodeURIComponent(labelId)}`,
        method: "DELETE",
      });
    } catch (error) {
      if (!isNylasErrorWithStatus(error, 404)) throw error;
    }
    this.foldersPromise = undefined;
  }

  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }): Promise<{ usedFallback?: boolean; actualLabelId?: string }> {
    const labelId =
      options.labelId || (await this.ensureLabel(options.labelName));
    if (!labelId) throw new Error("No label id or name was provided");

    // Nylas replaces the folder set, so applying one label means re-sending the
    // existing set with the new id added.
    const current = (await this.getMessage(options.messageId)).labelIds ?? [];
    if (!current.includes(labelId)) {
      await this.setFolders(options.messageId, [...current, labelId]);
    }

    return { actualLabelId: labelId };
  }

  async removeThreadLabel(threadId: string, labelId: string): Promise<void> {
    await this.removeThreadLabels(threadId, [labelId]);
  }

  async removeThreadLabels(
    threadId: string,
    labelIds: string[],
  ): Promise<void> {
    const messages = await this.threadMessages(threadId);
    const removed = new Set(labelIds);

    await mapWithConcurrency(
      messages,
      MUTATION_CONCURRENCY,
      async (message) => {
        const current = message.labelIds ?? [];
        const next = current.filter((labelId) => !removed.has(labelId));
        if (next.length !== current.length) {
          await this.setFolders(message.id, next);
        }
      },
    );
  }

  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ): Promise<void> {
    const folderId = await this.ensureLabel(folderName);
    if (!folderId) throw new Error(`Folder "${folderName}" was not found`);

    const messages = await this.threadMessages(threadId);
    await mapWithConcurrency(
      messages,
      MUTATION_CONCURRENCY,
      async (message) => {
        // Moving is replacement, not addition: the message leaves the folder it
        // was filed in. System labels are preserved so roles survive the move.
        const kept = (message.labelIds ?? []).filter(isSystemLabel);
        await this.setFolders(message.id, [...kept, folderId]);
      },
    );
  }

  async getFolders(): Promise<OutlookFolder[]> {
    return (await this.folders()).map(toOutlookFolder);
  }

  async getFolderCounts(): Promise<EmailFolderCount[]> {
    const folders = await this.folders();

    return folders.map((folder) => ({
      id: folder.id,
      name: folder.name ?? folder.id,
      total: folder.total_count ?? 0,
      unread: folder.unread_count ?? 0,
      systemType: roleOfFolder(folder),
    }));
  }

  async getOrCreateFolderIdByName(folderName: string): Promise<string> {
    const folderId = await this.ensureLabel(folderName);
    if (!folderId) throw new Error(`Folder "${folderName}" was not found`);
    return folderId;
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    await this.updateLabel(folderId, { name });
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.deleteLabel(folderId);
  }

  // ---------------------------------------------------------------- mutations

  async markMessagesReadState(
    messageIds: string[],
    read: boolean,
  ): Promise<void> {
    await mapWithConcurrency(messageIds, MUTATION_CONCURRENCY, (messageId) =>
      updateNylasMessage({
        grantId: this.grantId,
        messageId,
        unread: !read,
      }),
    );
  }

  async markMessagesStarredState(
    messageIds: string[],
    starred: boolean,
  ): Promise<void> {
    await mapWithConcurrency(messageIds, MUTATION_CONCURRENCY, (messageId) =>
      updateNylasMessage({ grantId: this.grantId, messageId, starred }),
    );
  }

  async archiveMessages(messageIds: string[]): Promise<void> {
    await this.removeFlagFromMessages(messageIds, GMAIL_FLAG_LABELS.inbox);
  }

  async unarchiveMessages(messageIds: string[]): Promise<void> {
    await this.addFlagToMessages(messageIds, GMAIL_FLAG_LABELS.inbox);
  }

  async trashMessages(messageIds: string[]): Promise<void> {
    await this.addFlagToMessages(messageIds, GMAIL_FLAG_LABELS.trash);
  }

  async untrashMessages(messageIds: string[]): Promise<void> {
    await this.removeFlagFromMessages(messageIds, GMAIL_FLAG_LABELS.trash);
  }

  async markSpam(threadId: string): Promise<void> {
    await this.setFlagForThread(threadId, GMAIL_FLAG_LABELS.spam, true);
  }

  async markNotSpam(threadId: string): Promise<void> {
    await this.setFlagForThread(threadId, GMAIL_FLAG_LABELS.spam, false);
  }

  async markRead(threadId: string): Promise<void> {
    await this.setReadForThread(threadId, true);
  }

  async markReadThread(threadId: string, read: boolean): Promise<void> {
    await this.setReadForThread(threadId, read);
  }

  async starMessage(messageId: string): Promise<void> {
    await this.markMessagesStarredState([messageId], true);
  }

  async archiveMessage(messageId: string): Promise<void> {
    await this.archiveMessages([messageId]);
  }

  async archiveThread(threadId: string, ownerEmail: string): Promise<void> {
    await this.archiveThreadWithLabel(threadId, ownerEmail);
  }

  async archiveThreadWithLabel(
    threadId: string,
    _ownerEmail: string,
    labelId?: string,
  ): Promise<void> {
    const messages = await this.threadMessages(threadId);
    await this.removeFlagFromMessages(
      messages.map((message) => message.id),
      GMAIL_FLAG_LABELS.inbox,
    );

    if (labelId) await this.addLabelToThread(threadId, labelId);
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.setFlagForThread(threadId, GMAIL_FLAG_LABELS.inbox, true);
  }

  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ): Promise<void> {
    await this.setFlagForThread(threadId, GMAIL_FLAG_LABELS.trash, true);
  }

  async untrashThread(threadId: string): Promise<void> {
    await this.setFlagForThread(threadId, GMAIL_FLAG_LABELS.trash, false);
  }

  async bulkArchiveThreads(
    threads: BulkArchiveThread[],
    ownerEmail: string,
  ): Promise<BulkArchiveResult> {
    const succeededThreadIds: string[] = [];
    const failedThreadIds: string[] = [];

    for (const batch of chunk(threads, 10)) {
      await Promise.all(
        batch.map(async (thread) => {
          try {
            await this.archiveThread(thread.threadId, ownerEmail);
            succeededThreadIds.push(thread.threadId);
          } catch (error) {
            this.logger.warn("Failed to archive thread", {
              threadId: thread.threadId,
              error,
            });
            failedThreadIds.push(thread.threadId);
          }
        }),
      );
    }

    return { succeededThreadIds, failedThreadIds };
  }

  async bulkArchiveFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    for (const fromEmail of fromEmails) {
      const { messages } = await this.getMessagesFromSender({
        senderEmail: fromEmail,
        maxResults: NYLAS_MAX_PAGE_SIZE,
      });
      await this.archiveMessages(messages.map((message) => message.id));
    }
  }

  async bulkArchiveSenderOrThrow(
    fromEmail: string,
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<number> {
    const { messages } = await this.getMessagesFromSender({
      senderEmail: fromEmail,
      maxResults: NYLAS_MAX_PAGE_SIZE,
    });

    await this.archiveMessages(messages.map((message) => message.id));
    return messages.length;
  }

  async bulkTrashFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    for (const fromEmail of fromEmails) {
      const { messages } = await this.getMessagesFromSender({
        senderEmail: fromEmail,
        maxResults: NYLAS_MAX_PAGE_SIZE,
      });
      await this.trashMessages(messages.map((message) => message.id));
    }
  }

  async blockUnsubscribedEmail(messageId: string): Promise<void> {
    // Sender blocking rode on Gmail filters, which need gmail.settings.basic.
    // Nylas has no equivalent, so the block is expressed as archive + removal
    // from the inbox rather than a provider-side rule.
    await this.archiveMessages([messageId]);
  }

  // ---------------------------------------------------------------- send + drafts

  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
    from?: string;
  }): Promise<{ messageId: string }> {
    const sent = await sendNylasMessage({
      grantId: this.grantId,
      body: {
        to: toParticipants(args.to),
        cc: optionalParticipants(args.cc),
        bcc: optionalParticipants(args.bcc),
        from: optionalParticipants(args.from),
        subject: args.subject,
        body: args.messageText,
        isPlaintext: true,
        attachments: mailerAttachments(args.attachments),
      },
    });

    return { messageId: sent.id };
  }

  async sendEmailWithHtml(
    body: SendEmailBody,
    _options?: SendEmailOptions,
  ): Promise<{ messageId: string; threadId: string }> {
    const sent = await sendNylasMessage({
      grantId: this.grantId,
      body: {
        to: toParticipants(body.to),
        cc: optionalParticipants(body.cc),
        bcc: optionalParticipants(body.bcc),
        from: optionalParticipants(body.from),
        subject: body.subject,
        body: body.messageHtml,
        replyToMessageId: body.replyToEmail?.messageId,
        attachments: sendBodyAttachments(body.attachments),
      },
    });

    return { messageId: sent.id, threadId: sent.thread_id ?? sent.id };
  }

  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: {
      replyTo?: string;
      from?: string;
      attachments?: MailAttachment[];
    },
  ): Promise<{ messageId: string }> {
    const sent = await sendNylasMessage({
      grantId: this.grantId,
      body: {
        to: toParticipants(
          options?.replyTo || email.headers["reply-to"] || email.headers.from,
        ),
        from: optionalParticipants(options?.from),
        subject: replySubject(email.subject),
        body: content,
        // Threading is Nylas' job: it maps this to the provider's reply link.
        replyToMessageId: email.id,
        attachments: mailerAttachments(options?.attachments),
      },
    });

    return { messageId: sent.id };
  }

  async forwardEmail(
    email: ParsedMessage,
    args: {
      to: string;
      cc?: string;
      bcc?: string;
      content?: string;
      from?: string;
    },
  ): Promise<{ messageId: string }> {
    // Nylas takes attachment bytes inline with the send, so the originals have
    // to be fetched first; a forward that silently dropped them would be worse
    // than a slower send.
    const attachments = await mapWithConcurrency(
      email.attachments ?? [],
      3,
      async (attachment) => {
        const { data } = await this.getAttachment(
          email.id,
          attachment.attachmentId,
        );
        return {
          filename: attachment.filename,
          contentType: attachment.mimeType,
          content: data,
        };
      },
    );

    const sent = await sendNylasMessage({
      grantId: this.grantId,
      body: {
        to: toParticipants(args.to),
        cc: optionalParticipants(args.cc),
        bcc: optionalParticipants(args.bcc),
        from: optionalParticipants(args.from),
        subject: email.subject.startsWith("Fwd: ")
          ? email.subject
          : `Fwd: ${email.subject}`,
        body: args.content ?? email.textHtml ?? email.textPlain ?? "",
        attachments,
      },
    });

    return { messageId: sent.id };
  }

  async createDraft(params: {
    to: string;
    from?: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
    forwardedMessageId?: string;
  }): Promise<{ id: string }> {
    const response = await nylasFetch<{ data?: { id?: string } }>({
      path: `/grants/${this.grantId}/drafts`,
      method: "POST",
      body: {
        to: toParticipants(params.to),
        cc: optionalParticipants(params.cc),
        bcc: optionalParticipants(params.bcc),
        ...(params.from ? { from: toParticipants(params.from) } : {}),
        subject: params.subject,
        body: params.messageHtml,
        ...(params.replyToMessageId
          ? { reply_to_message_id: params.replyToMessageId }
          : {}),
      },
    });

    if (!response.data?.id) throw new Error("Nylas created no draft id");
    return { id: response.data.id };
  }

  async updateDraft(
    draftId: string,
    params: {
      messageHtml?: string;
      subject?: string;
      to?: string;
      from?: string;
      cc?: string;
      bcc?: string;
    },
  ): Promise<void> {
    await nylasFetch({
      path: `/grants/${this.grantId}/drafts/${encodeURIComponent(draftId)}`,
      method: "PUT",
      body: {
        ...(params.messageHtml === undefined
          ? {}
          : { body: params.messageHtml }),
        ...(params.subject === undefined ? {} : { subject: params.subject }),
        ...(params.to === undefined ? {} : { to: toParticipants(params.to) }),
        ...(params.from === undefined
          ? {}
          : { from: toParticipants(params.from) }),
        ...(params.cc === undefined ? {} : { cc: toParticipants(params.cc) }),
        ...(params.bcc === undefined
          ? {}
          : { bcc: toParticipants(params.bcc) }),
      },
    });
  }

  async deleteDraft(draftId: string, _version?: string): Promise<boolean> {
    try {
      await nylasFetch({
        path: `/grants/${this.grantId}/drafts/${encodeURIComponent(draftId)}`,
        method: "DELETE",
      });
      return true;
    } catch (error) {
      if (isNylasErrorWithStatus(error, 404)) return true;
      throw error;
    }
  }

  async sendDraft(
    draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    const response = await nylasFetch<{
      data?: { id?: string; thread_id?: string };
    }>({
      path: `/grants/${this.grantId}/drafts/${encodeURIComponent(draftId)}`,
      method: "POST",
    });

    if (!response.data?.id) {
      throw new Error("Nylas sent the draft but returned no message id");
    }

    return {
      messageId: response.data.id,
      threadId: response.data.thread_id ?? response.data.id,
    };
  }

  async draftEmail(
    email: ParsedMessage,
    args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
    _userEmail: string,
    _executedRule?: { id: string; threadId: string; emailAccountId: string },
  ): Promise<{ draftId: string }> {
    const created = await this.createDraft({
      to: args.to || email.headers["reply-to"] || email.headers.from,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject || replySubject(email.subject),
      messageHtml: args.content,
      replyToMessageId: email.id,
    });

    return { draftId: created.id };
  }

  async getDraftAttachments(
    draftId: string,
  ): Promise<DraftAttachmentsResult | null> {
    const draft = await this.getDraft(draftId);
    if (!draft) return null;

    return {
      messageId: draft.id,
      attachments: [...(draft.attachments ?? []), ...draft.inline].map(
        (attachment) => ({
          id: attachment.attachmentId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          disposition: draft.inline.some(
            (inline) => inline.attachmentId === attachment.attachmentId,
          )
            ? ("inline" as const)
            : ("attachment" as const),
          contentId: attachment.headers["content-id"] || undefined,
          messageId: draft.id,
          providerAttachmentId: attachment.attachmentId,
        }),
      ),
    };
  }

  async addDraftAttachment(
    _draftId: string,
    _attachment: DraftAttachmentMetadata & { content: Buffer },
  ): Promise<DraftAttachmentsResult & { attachmentId: string }> {
    throw new NylasUnsupportedFeatureError(
      "attaching files to an existing draft",
    );
  }

  async removeDraftAttachment(
    _draftId: string,
    _attachmentId: string,
  ): Promise<DraftAttachmentsResult> {
    throw new NylasUnsupportedFeatureError(
      "removing a file from an existing draft",
    );
  }

  async startDraftAttachmentUpload(
    _draftId: string,
    _attachment: DraftAttachmentMetadata,
  ): Promise<DraftAttachmentUploadStart> {
    throw new NylasUnsupportedFeatureError(
      "resumable uploads of large draft attachments",
    );
  }

  // ---------------------------------------------------------------- capabilities Nylas lacks

  async createFilter(_options: {
    from: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<{ status: number }> {
    throw new NylasUnsupportedFeatureError("server-side mail filters");
  }

  async getFiltersList(): Promise<EmailFilter[]> {
    return [];
  }

  async deleteFilter(_id: string): Promise<{ status: number }> {
    throw new NylasUnsupportedFeatureError("server-side mail filters");
  }

  async createAutoArchiveFilter(_options: {
    from: string;
    gmailLabelId?: string;
    labelName?: string;
  }): Promise<{ status: number }> {
    throw new NylasUnsupportedFeatureError("server-side mail filters");
  }

  async getSendAsAddresses(): Promise<SendAsAddress[]> {
    // Requires gmail.settings.basic, which Nylas does not request.
    return [];
  }

  async getSignatures(): Promise<EmailSignature[]> {
    // Nylas never reads or applies the provider's own signature. OneMail's
    // stored signature is the source of truth for Google mailboxes.
    return [];
  }

  async getForwardingAddresses(): Promise<string[]> {
    return [];
  }

  async getContactPhotos(): Promise<Record<string, string>> {
    return listNylasContactPhotos({ grantId: this.grantId });
  }

  async searchContacts(query: string): Promise<EmailContact[]> {
    return searchNylasContacts({
      grantId: this.grantId,
      query,
      logger: this.logger,
    });
  }

  /**
   * Push is application-level for Nylas: one webhook covers every grant, so
   * there is no per-mailbox subscription to create.
   */
  async watchEmails(): Promise<{
    expirationDate: Date;
    subscriptionId?: string;
  } | null> {
    return null;
  }

  async unwatchEmails(_subscriptionId?: string): Promise<void> {}

  // ---------------------------------------------------------------- predicates

  isSentMessage(message: ParsedMessage): boolean {
    return hasLabel(message, GMAIL_FLAG_LABELS.sent);
  }

  isReplyInThread(message: ParsedMessage): boolean {
    return Boolean(
      message.headers["in-reply-to"] || message.headers.references,
    );
  }

  // ---------------------------------------------------------------- internals

  private async folders(): Promise<NylasFolder[]> {
    this.foldersPromise ??= listNylasFolders(this.grantId).catch((error) => {
      this.foldersPromise = undefined;
      throw error;
    });
    return this.foldersPromise;
  }

  private async folderId(role: OutlookSystemFolder): Promise<string> {
    const folderId = findFolderIdByRole(await this.folders(), role);
    if (!folderId) {
      throw new Error(`Nylas grant ${this.grantId} has no ${role} folder`);
    }
    return folderId;
  }

  /** A label id is usable as a folder id as-is; a name needs resolving. */
  private async labelFolderId(labelId: string): Promise<string | undefined> {
    const folders = await this.folders();
    if (folders.some((folder) => folder.id === labelId)) return labelId;
    return this.ensureLabel(labelId);
  }

  private async ensureLabel(name: string | null): Promise<string | undefined> {
    if (!name) return;
    const existing = await this.getLabelByName(name);
    if (existing) return existing.id;
    const created = await this.createLabel(name);
    return created.id;
  }

  private async setFolders(messageId: string, folders: string[]) {
    await updateNylasMessage({
      grantId: this.grantId,
      messageId,
      folders,
    });
  }

  private async addFlagToMessages(messageIds: string[], flag: string) {
    await mapWithConcurrency(messageIds, MUTATION_CONCURRENCY, async (id) => {
      const current = (await this.getMessage(id)).labelIds ?? [];
      if (!current.includes(flag)) {
        await this.setFolders(id, [...current, flag]);
      }
    });
  }

  private async removeFlagFromMessages(messageIds: string[], flag: string) {
    await mapWithConcurrency(messageIds, MUTATION_CONCURRENCY, async (id) => {
      const current = (await this.getMessage(id)).labelIds ?? [];
      if (current.includes(flag)) {
        await this.setFolders(
          id,
          current.filter((labelId) => labelId !== flag),
        );
      }
    });
  }

  private async addLabelToThread(threadId: string, labelId: string) {
    const messages = await this.threadMessages(threadId);
    await mapWithConcurrency(
      messages,
      MUTATION_CONCURRENCY,
      async (message) => {
        const current = message.labelIds ?? [];
        if (!current.includes(labelId)) {
          await this.setFolders(message.id, [...current, labelId]);
        }
      },
    );
  }

  private async setFlagForThread(
    threadId: string,
    flag: string,
    present: boolean,
  ) {
    const messages = await this.threadMessages(threadId);
    const ids = messages.map((message) => message.id);

    if (present) await this.addFlagToMessages(ids, flag);
    else await this.removeFlagFromMessages(ids, flag);
  }

  private async setReadForThread(threadId: string, read: boolean) {
    const messages = await this.threadMessages(threadId);
    await this.markMessagesReadState(
      messages.map((message) => message.id),
      read,
    );
  }

  private async threadMessages(threadId: string): Promise<ParsedMessage[]> {
    const messages = await listNylasThreadMessages({
      grantId: this.grantId,
      threadId,
    });
    return messages.map(toParsedMessage);
  }

  private async threadFromSummary(thread: NylasThread): Promise<EmailThread> {
    const messages = await this.threadMessages(thread.id);

    return {
      id: thread.id,
      messages: sortedByDate(messages),
      snippet: thread.snippet ?? messages.at(-1)?.snippet ?? "",
    };
  }

  private async findMessage(messageId: string): Promise<ParsedMessage | null> {
    try {
      return await this.getMessage(messageId);
    } catch (error) {
      if (isNylasErrorWithStatus(error, 404)) return null;
      throw error;
    }
  }

  /** Maps the engine's mailbox search onto Nylas list filters. */
  private async scopeFromMailboxSearch(
    search: ProviderMailboxSearch | undefined,
  ): Promise<{
    folderId?: string;
    unread?: boolean;
    starred?: boolean;
    hasAttachment?: boolean;
    text?: string;
  }> {
    if (!search) return {};

    const mailboxRole: Record<string, OutlookSystemFolder> = {
      inbox: "INBOX",
      sent: "SENT",
      drafts: "DRAFT",
      spam: "SPAM",
      trash: "TRASH",
      archive: "ARCHIVE",
    };

    const role = mailboxRole[search.mailbox];
    const folderId = role ? await this.folderId(role) : undefined;

    return {
      folderId,
      // `read: true` means already read, which Nylas expresses as unread=false.
      unread: search.read === undefined ? undefined : !search.read,
      starred: search.starred,
      hasAttachment: search.hasAttachment,
      text: search.text?.value,
    };
  }
}

// ---------------------------------------------------------------- helpers

/** Gmail label ids that name a role rather than a user folder. */
const GMAIL_SYSTEM_LABEL_IDS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "ARCHIVE",
]);

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  INBOX: "Inbox",
  SENT: "Sent",
  DRAFT: "Drafts",
  TRASH: "Trash",
  SPAM: "Spam",
};

function isSystemLabel(labelId: string) {
  return GMAIL_SYSTEM_LABEL_IDS.has(labelId);
}

function hasLabel(message: ParsedMessage, label: string) {
  return (message.labelIds ?? []).includes(label);
}

function isDraft(message: ParsedMessage) {
  return hasLabel(message, GMAIL_FLAG_LABELS.draft);
}

function sortedByDate(messages: ParsedMessage[]) {
  return [...messages].sort(
    (left, right) => Date.parse(left.date) - Date.parse(right.date),
  );
}

function toEmailLabel(folder: NylasFolder): EmailLabel {
  return {
    id: folder.id,
    name: ROLE_DISPLAY_NAMES[folder.id] ?? folder.name ?? folder.id,
    type: folder.system_folder ? "system" : "user",
    threadsTotal: folder.total_count ?? undefined,
    threadsUnread: folder.unread_count ?? undefined,
  };
}

function shiftBack(isoDate: string) {
  return new Date(Date.parse(isoDate) - DELTA_OVERLAP_MS);
}

function newestTimestamp(messages: ParsedMessage[]): string | undefined {
  const newest = messages.reduce<number>((latest, message) => {
    const parsed = Date.parse(message.date);
    return Number.isFinite(parsed) && parsed > latest ? parsed : latest;
  }, 0);

  return newest > 0 ? new Date(newest).toISOString() : undefined;
}

function stripAngleBrackets(value: string) {
  return value.trim().replace(/^<|>$/g, "");
}

function replySubject(subject: string) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function toParticipants(value: string) {
  return splitRecipientList(value).map((entry) => {
    // Only a bracketed address carries a display name; a bare address is its
    // own name and must not be echoed back as one.
    const match = entry.match(/^(.*)<([^>]+)>/);
    if (!match) return { email: entry.trim() };

    const name = match[1].trim();
    const email = match[2].trim();
    return name ? { name, email } : { email };
  });
}

function optionalParticipants(value: string | undefined) {
  return value ? toParticipants(value) : undefined;
}

function unreadFromReadState(readState: "read" | "unread" | undefined) {
  if (readState === "unread") return true;
  return;
}

/** Gmail's own operators pass through Nylas untouched, so queries compose. */
function buildNativeSearch(
  query: string | undefined,
  labelName: string | undefined,
  text: string | undefined,
) {
  const parts = [query, labelName ? `label:${labelName}` : undefined, text];
  const joined = parts.filter(Boolean).join(" ").trim();
  return joined || undefined;
}

function mailerAttachments(attachments: MailAttachment[] | undefined) {
  return attachments?.map((attachment) => {
    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(String(attachment.content ?? ""), "base64");

    if (content.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new NylasUnsupportedFeatureError(
        "sending an attachment larger than 3 MB in a single request",
      );
    }

    return {
      filename: attachment.filename ?? "attachment",
      contentType:
        typeof attachment.contentType === "string"
          ? attachment.contentType
          : "application/octet-stream",
      content: content.toString("base64"),
      contentId:
        "cid" in attachment && typeof attachment.cid === "string"
          ? attachment.cid
          : undefined,
    };
  });
}

function sendBodyAttachments(
  attachments: SendEmailBody["attachments"],
): ReturnType<typeof mailerAttachments> {
  return attachments?.map((attachment) => {
    const size = Buffer.from(attachment.content, "base64").byteLength;
    if (size > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new NylasUnsupportedFeatureError(
        "sending an attachment larger than 3 MB in a single request",
      );
    }

    return {
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content,
      contentId: attachment.contentId,
    };
  });
}

function notFound(message: string) {
  const error = new Error(message);
  error.name = "NylasNotFoundError";
  return error;
}
