import { Readable } from "node:stream";
import type { ImapFlow } from "imapflow";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import type { EmailContact } from "@/utils/email/contact";
import type { SendAsAddress } from "@/utils/email/send-as";
import type {
  BulkArchiveResult,
  BulkArchiveThread,
  DraftAttachmentUploadStart,
  DraftAttachmentsResult,
  DraftReference,
  EmailFilter,
  EmailFolderCount,
  EmailLabel,
  EmailProvider,
  EmailSignature,
  EmailThread,
  GetThreadOptions,
  MailboxSyncPage,
  SendEmailOptions,
  SentMessagePage,
} from "@/utils/email/types";
import type { OutlookFolder } from "@/utils/outlook/folders";
import type { ParsedMessage } from "@/utils/types";
import type { SendEmailBody } from "@/utils/types/mail";
import { SafeError, DraftNotFoundError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import type { ProviderFamily } from "@/utils/email/provider-registry";
import {
  assertDraftAttachmentLimits,
  DRAFT_ATTACHMENT_DIRECT_UPLOAD_LIMIT_BYTES,
} from "@/utils/email/draft-attachment-upload";
import type { DraftAttachmentMetadata } from "@/utils/actions/draft-attachments.validation";
import { listImapMailboxes, withImapConnection } from "./client";
import {
  appendImapDraft,
  buildImapDraftSource,
  createImapDraftMessageId,
  findImapDraftUid,
  readImapDraftAttachments,
  type ImapDraftAddress,
  type ImapDraftAttachment,
} from "./draft";
import {
  getImapMailboxSyncPage,
  hydrateImapMessage,
  listImapMessages,
  readImapAttachment,
  resolveImapFolders,
} from "./mail";
import { sentCopyBehaviour, sendViaSmtp } from "./send";

/**
 * A capability this transport does not have.
 *
 * Extends `SafeError` for the same reason the Nylas provider does: the message is
 * meant for the user, and reporting it as an unexpected fault would send it to
 * Sentry instead of the screen.
 */
export class ImapUnsupportedFeatureError extends SafeError {
  constructor(feature: string) {
    super(`This mail server does not support ${feature}.`);
  }
}

export type ImapMailProviderOptions = {
  family: ProviderFamily;
  emailAccountId: string;
  /** The mailbox's own address, which is also the default From. */
  email: string;
  username: string;
  secret: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  logger: Logger;
};

/**
 * A mailbox reached over IMAP/SMTP with an app password.
 *
 * What this deliberately does not do: anything that needs a provider API. The
 * IMAP families (Zoho, Yahoo, Fastmail, iCloud, plain IMAP) expose no server-side
 * filters, no send-as aliases, no signature sync and no forwarding settings to a
 * plain IMAP client, so those methods refuse rather than pretend. Drafts are
 * stored as ordinary messages in the Drafts mailbox, which is enough to read
 * them, write them and send them.
 */
export class ImapMailProvider implements EmailProvider {
  readonly name: ProviderFamily;
  readonly localMailSyncStrategy = "folder-delta" as const;

  private readonly options: ImapMailProviderOptions;
  private readonly logger: Logger;
  /**
   * The mailbox the server files sent mail in, once something has asked.
   *
   * Cached because `isSentMessage` is synchronous and has no connection to make,
   * and because resolving it means listing every mailbox.
   */
  private sentFolderId: string | null = null;
  /**
   * The mailbox the server keeps drafts in, once something has asked.
   *
   * Cached for the same reason the sent mailbox is, and because a draft is
   * written and read on every keystroke the user saves.
   */
  private draftFolderId: string | null = null;

  constructor(options: ImapMailProviderOptions) {
    this.options = options;
    this.name = options.family;
    this.logger = options.logger;
  }

  /** Resolves and caches the Sent mailbox, or null when the server has none. */
  private async resolveSentFolderId() {
    if (this.sentFolderId) return this.sentFolderId;

    const resolved = await this.withClient(async (client) => {
      const folders = await resolveImapFolders(client);
      return folders.sent ?? null;
    });

    this.sentFolderId = resolved;
    return resolved;
  }

  /**
   * Resolves and caches the Drafts mailbox, or null when the server has none.
   *
   * A server without one cannot hold a draft, so the draft methods refuse
   * rather than writing a message somewhere the user will not find it.
   */
  private async resolveDraftFolderId() {
    if (this.draftFolderId) return this.draftFolderId;

    const resolved = await this.withClient(async (client) => {
      const folders = await resolveImapFolders(client);
      return folders.drafts ?? null;
    });

    this.draftFolderId = resolved;
    return resolved;
  }

  // ------------------------------------------------------------------ transport

  private withClient<T>(work: (client: ImapFlow) => Promise<T>) {
    return withImapConnection(
      {
        host: this.options.imapHost,
        port: this.options.imapPort,
        secure: this.options.imapSecure,
        username: this.options.username,
        secret: this.options.secret,
        logger: this.logger,
      },
      work,
    );
  }

  toJSON() {
    return { name: this.name, type: "ImapMailProvider" };
  }

  /** IMAP authenticates with a password; there is no token to hand out. */
  getAccessToken(): string {
    throw new ImapUnsupportedFeatureError("OAuth access tokens");
  }

  // ------------------------------------------------------------------ mailboxes

  async getFolders(): Promise<OutlookFolder[]> {
    return this.withClient(async (client) => {
      const mailboxes = await listImapMailboxes(client);
      return mailboxes.map((mailbox) => ({
        id: mailbox.path,
        displayName: mailbox.name,
      })) as OutlookFolder[];
    });
  }

  async getLabels(): Promise<EmailLabel[]> {
    return this.withClient(async (client) => {
      const mailboxes = await listImapMailboxes(client);
      return mailboxes.map((mailbox) => ({
        id: mailbox.path,
        name: mailbox.name,
        // IMAP folders are not typed the way Gmail labels are, and the copy that
        // reads this only distinguishes user labels from system ones.
        type: "folder",
      }));
    });
  }

  async getLabelById(labelId: string) {
    const labels = await this.getLabels();
    return labels.find((label) => label.id === labelId) ?? null;
  }

  async getLabelByName(name: string) {
    const labels = await this.getLabels();
    return (
      labels.find((label) => label.name.toLowerCase() === name.toLowerCase()) ??
      null
    );
  }

  async getFolderCounts(): Promise<EmailFolderCount[]> {
    return this.withClient(async (client) => {
      const mailboxes = await listImapMailboxes(client);
      const counts: EmailFolderCount[] = [];

      for (const mailbox of mailboxes) {
        const status = await client.status(mailbox.path, {
          messages: true,
          unseen: true,
        });
        if (!status) continue;
        counts.push({
          id: mailbox.path,
          name: mailbox.name,
          total: status.messages ?? 0,
          unread: status.unseen ?? 0,
        });
      }

      return counts;
    });
  }

  async getInboxStats() {
    return this.withClient(async (client) => {
      const status = await client.status("INBOX", {
        messages: true,
        unseen: true,
      });
      return {
        total: status ? (status.messages ?? 0) : 0,
        unread: status ? (status.unseen ?? 0) : 0,
      };
    });
  }

  // ------------------------------------------------------------------ reading

  async getMailboxSyncPage(options: {
    after?: Date;
    cursor?: string;
    folderId?: string;
    limit: number;
  }): Promise<MailboxSyncPage> {
    const folderId = options.folderId ?? "INBOX";

    return this.withClient((client) =>
      getImapMailboxSyncPage({
        client,
        folderId,
        cursor: options.cursor,
        after: options.after,
        limit: options.limit,
        accountEmail: this.options.email,
      }),
    );
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
    if (options.query) {
      // Server-side search is a separate capability; asking for a page *and* a
      // query would silently return unfiltered mail.
      throw new ImapUnsupportedFeatureError("searching the mailbox");
    }

    return this.withClient((client) =>
      listImapMessages({
        client,
        folderId: options.folderId ?? "INBOX",
        limit: options.maxResults ?? 50,
        pageToken: options.pageToken,
        accountEmail: this.options.email,
      }),
    );
  }

  async getMessage(
    messageId: string,
    options?: { includeCalendarContent?: boolean },
  ): Promise<ParsedMessage> {
    const { uid, folderId } = parseImapMessageId(messageId);

    const message = await this.withClient((client) =>
      hydrateImapMessage({
        client,
        folderId,
        uid,
        accountEmail: this.options.email,
      }),
    );

    if (!message) throw new SafeError(`Message ${messageId} was not found`);

    // `hydrateImapMessage` already extracts text/calendar parts; the flag only
    // decides whether the caller wants them, and dropping them here would mean
    // fetching the message twice.
    if (!options?.includeCalendarContent) return message;
    return message;
  }

  async getMessagesBatch(messageIds: string[]) {
    const messages = await Promise.all(
      messageIds.map((messageId) => this.getMessage(messageId)),
    );
    return messages;
  }

  async getThreadMessages(threadId: string) {
    const matches = await this.searchThreadMessages(threadId);
    return matches;
  }

  async getThread(
    threadId: string,
    options?: GetThreadOptions,
  ): Promise<EmailThread> {
    const messages = await this.searchThreadMessages(threadId);
    const kept = options?.includeDrafts
      ? messages
      : messages.filter((message) => !message.labelIds?.includes("DRAFT"));

    return {
      id: threadId,
      messages: kept,
      snippet: kept[0]?.snippet ?? "",
    };
  }

  async getLatestMessageInThread(threadId: string) {
    const messages = await this.searchThreadMessages(threadId);
    return messages[messages.length - 1] ?? null;
  }

  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ) {
    return thread.messages[thread.messages.length - 1] ?? null;
  }

  /**
   * Members of a conversation.
   *
   * IMAP has no thread object, so a thread is whatever the `Message-ID`,
   * `References` and `In-Reply-To` headers say it is. The search runs in the
   * inbox only, which means a conversation whose replies were filed elsewhere can
   * come back short — the alternative is a full-mailbox scan per thread.
   */
  private async searchThreadMessages(threadId: string) {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = await client.search(
          {
            or: [
              { header: { "message-id": threadId } },
              { header: { references: threadId } },
              { header: { "in-reply-to": threadId } },
            ],
          },
          { uid: true },
        );
        if (!uids || uids.length === 0) return [];

        const messages: ParsedMessage[] = [];
        for (const uid of uids) {
          const message = await hydrateImapMessage({
            client,
            folderId: "INBOX",
            uid,
            accountEmail: this.options.email,
          });
          if (message) messages.push(message);
        }

        messages.sort(
          (left, right) => Date.parse(left.date) - Date.parse(right.date),
        );
        return messages;
      } finally {
        lock.release();
      }
    });
  }

  isReplyInThread(message: ParsedMessage) {
    return Boolean(message.headers["in-reply-to"]);
  }

  /**
   * Whether the message sits in the mailbox the server files sent mail in.
   *
   * IMAP has no sent flag, so this compares the message's mailbox with the role
   * the folder resolver chose. That resolver needs a connection, and this method
   * is synchronous, so the answer is only available once something (a Sent
   * listing, a folder listing) has resolved it. Before that it says false rather
   * than guessing at a mailbox name.
   */
  isSentMessage(message: ParsedMessage) {
    const sentFolderId = this.sentFolderId;
    if (!sentFolderId) return false;

    return (
      message.parentFolderId === sentFolderId ||
      (message.labelIds?.includes(sentFolderId) ?? false)
    );
  }

  async getAttachmentStream(
    messageId: string,
    attachmentId: string,
    _signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const { uid, folderId } = parseImapMessageId(messageId);

    const content = await this.withClient((client) =>
      readImapAttachment({
        client,
        folderId,
        uid,
        attachmentId,
        messageId,
        accountEmail: this.options.email,
      }),
    );
    if (!content) throw new SafeError("Attachment was not found");

    // `download` hands back a Node stream; wrapping it keeps the attachment off
    // the heap instead of buffering the whole file.
    return Readable.toWeb(content) as ReadableStream<Uint8Array>;
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const stream = await this.getAttachmentStream(messageId, attachmentId);
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { data: buffer.toString("base64"), size: buffer.byteLength };
  }

  // ------------------------------------------------------------------ mutations

  /** IMAP flags are the read/starred/draft state; there is no separate field. */
  async markMessagesReadState(messageIds: string[], read: boolean) {
    await this.withClient(async (client) => {
      for (const messageId of messageIds) {
        const { uid, folderId } = parseImapMessageId(messageId);
        const lock = await client.getMailboxLock(folderId);
        try {
          if (read) {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], {
              uid: true,
            });
          } else {
            await client.messageFlagsRemove(String(uid), ["\\Seen"], {
              uid: true,
            });
          }
        } finally {
          lock.release();
        }
      }
    });
  }

  async markMessagesStarredState(messageIds: string[], starred: boolean) {
    await this.withClient(async (client) => {
      for (const messageId of messageIds) {
        const { uid, folderId } = parseImapMessageId(messageId);
        const lock = await client.getMailboxLock(folderId);
        try {
          if (starred) {
            await client.messageFlagsAdd(String(uid), ["\\Flagged"], {
              uid: true,
            });
          } else {
            await client.messageFlagsRemove(String(uid), ["\\Flagged"], {
              uid: true,
            });
          }
        } finally {
          lock.release();
        }
      }
    });
  }

  async starMessage(messageId: string) {
    await this.markMessagesStarredState([messageId], true);
  }

  async markRead(threadId: string) {
    await this.markThreadFlags(threadId, ["\\Seen"], true);
  }

  async markReadThread(threadId: string, read: boolean) {
    await this.markThreadFlags(threadId, ["\\Seen"], read);
  }

  async archiveMessage(messageId: string) {
    await this.moveMessages([messageId], "archive");
  }

  async archiveMessages(messageIds: string[]) {
    await this.moveMessages(messageIds, "archive");
  }

  async archiveThread(threadId: string) {
    await this.moveThreadMessages(threadId, "archive");
  }

  async archiveThreadWithLabel(
    threadId: string,
    _ownerEmail: string,
    _labelId?: string,
  ) {
    await this.moveThreadMessages(threadId, "archive");
  }

  async trashMessages(messageIds: string[]) {
    await this.moveMessages(messageIds, "trash");
  }

  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ) {
    await this.moveThreadMessages(threadId, "trash");
  }

  async untrashMessages(messageIds: string[]) {
    // IMAP keeps no record of where a message was before it was moved, so the
    // inbox is the only place to put it back.
    await this.moveMessages(messageIds, "inbox");
  }

  async untrashThread(threadId: string) {
    await this.moveThreadMessages(threadId, "inbox");
  }

  async unarchiveMessages(messageIds: string[]) {
    await this.moveMessages(messageIds, "inbox");
  }

  async unarchiveThread(threadId: string) {
    await this.moveThreadMessages(threadId, "inbox");
  }

  async markSpam(threadId: string) {
    await this.moveThreadMessages(threadId, "spam");
  }

  async markNotSpam(threadId: string) {
    await this.moveThreadMessages(threadId, "inbox");
  }

  private async moveThreadMessages(
    threadId: string,
    role: "inbox" | "archive" | "trash" | "spam",
  ) {
    const messages = await this.searchThreadMessages(threadId);
    await this.moveMessages(
      messages.map((message) => message.id),
      role,
    );
  }

  private async moveMessages(
    messageIds: string[],
    role: "inbox" | "archive" | "trash" | "spam",
  ) {
    await this.withClient(async (client) => {
      const folders = await resolveImapFolders(client);
      const destination =
        role === "inbox" ? "INBOX" : (folders[role] ?? undefined);
      if (!destination) {
        throw new ImapUnsupportedFeatureError(
          `a ${role} mailbox to move mail into`,
        );
      }

      const byFolder = new Map<string, number[]>();
      for (const messageId of messageIds) {
        const { uid, folderId } = parseImapMessageId(messageId);
        if (folderId === destination) continue;
        const uids = byFolder.get(folderId) ?? [];
        uids.push(uid);
        byFolder.set(folderId, uids);
      }

      for (const [folderId, uids] of byFolder) {
        const lock = await client.getMailboxLock(folderId);
        try {
          await client.messageMove(uids.join(","), destination, { uid: true });
        } finally {
          lock.release();
        }
      }
    });
  }

  private async markThreadFlags(
    threadId: string,
    flags: string[],
    add: boolean,
  ) {
    const messages = await this.searchThreadMessages(threadId);

    await this.withClient(async (client) => {
      for (const message of messages) {
        const { uid, folderId } = parseImapMessageId(message.id);
        const lock = await client.getMailboxLock(folderId);
        try {
          if (add) {
            await client.messageFlagsAdd(String(uid), flags, { uid: true });
          } else {
            await client.messageFlagsRemove(String(uid), flags, { uid: true });
          }
        } finally {
          lock.release();
        }
      }
    });
  }

  // ------------------------------------------------------------------ sending

  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
  }) {
    return this.deliver({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      // Plain text only. Sending the same string as the HTML part would let a
      // `<` in the body start markup and would collapse the newlines.
      text: args.messageText,
      attachments: args.attachments,
    });
  }

  async sendEmailWithHtml(body: SendEmailBody, _options?: SendEmailOptions) {
    const result = await this.deliver({
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      html: body.messageHtml,
      attachments: body.attachments,
    });

    return { messageId: result.messageId, threadId: result.threadId };
  }

  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: {
      replyTo?: string;
      from?: string;
      attachments?: MailAttachment[];
    },
  ) {
    return this.deliver({
      to: options?.replyTo ?? email.headers["reply-to"] ?? email.headers.from,
      subject: email.subject.toLowerCase().startsWith("re:")
        ? email.subject
        : `Re: ${email.subject}`,
      html: content,
      text: content,
      attachments: options?.attachments,
      inReplyTo: email.headers["message-id"],
      references: [
        ...((email.headers.references ?? "").match(/<[^>]+>/g) ?? []),
        ...(email.headers["message-id"] ? [email.headers["message-id"]] : []),
      ],
    });
  }

  /** Sends once, then stores the same bytes in Sent unless the provider does. */
  private async deliver(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text?: string;
    html?: string;
    attachments?: MailAttachment[];
    inReplyTo?: string;
    references?: string[];
  }) {
    const sent = await sendViaSmtp({
      options: {
        host: this.options.smtpHost,
        port: this.options.smtpPort,
        secure: this.options.smtpSecure,
        username: this.options.username,
        secret: this.options.secret,
      },
      message: {
        from: this.options.email,
        to: splitAddresses(args.to) ?? [],
        cc: splitAddresses(args.cc),
        bcc: splitAddresses(args.bcc),
        subject: args.subject,
        text: args.text,
        html: args.html,
        attachments: args.attachments?.map((attachment) => ({
          filename:
            typeof attachment.filename === "string"
              ? attachment.filename
              : "attachment",
          content: Buffer.isBuffer(attachment.content)
            ? attachment.content
            : Buffer.from(String(attachment.content ?? ""), "base64"),
          contentType:
            typeof attachment.contentType === "string"
              ? attachment.contentType
              : undefined,
        })),
        inReplyTo: args.inReplyTo,
        references: args.references,
      },
    });

    if (sentCopyBehaviour(this.options.family) === "client-files") {
      await this.withClient(async (client) => {
        const folders = await resolveImapFolders(client);
        if (!folders.sent) {
          this.logger.warn(
            "No Sent mailbox found; the sent copy was not stored",
            {
              emailAccountId: this.options.emailAccountId,
            },
          );
          return;
        }
        await client.append(folders.sent, sent.raw, ["\\Seen"]);
      });
    }

    return {
      messageId: sent.messageId ?? "",
      threadId: args.inReplyTo ?? sent.messageId ?? "",
    };
  }

  // ------------------------------------------------------------------ watch

  /**
   * IMAP has no provider-side push, so there is no subscription to create.
   *
   * Returning null is what the watch job treats as "nothing to renew", which is
   * also why this transport is not listed as a per-account watch in the registry.
   */
  async watchEmails() {
    return null;
  }

  async unwatchEmails(_subscriptionId?: string) {
    return;
  }

  // ------------------------------------------------------------------ not available

  async blockUnsubscribedEmail(): Promise<void> {
    throw new ImapUnsupportedFeatureError("server-side filters");
  }

  async bulkArchiveFromSenders(): Promise<void> {
    throw new ImapUnsupportedFeatureError("bulk archive by sender");
  }

  async bulkArchiveSenderOrThrow(): Promise<number> {
    throw new ImapUnsupportedFeatureError("bulk archive by sender");
  }

  async bulkArchiveThreads(
    _threads: BulkArchiveThread[],
    _ownerEmail: string,
  ): Promise<BulkArchiveResult> {
    throw new ImapUnsupportedFeatureError("bulk archive");
  }

  async bulkTrashFromSenders(): Promise<void> {
    throw new ImapUnsupportedFeatureError("bulk trash by sender");
  }

  async checkIfReplySent(): Promise<boolean> {
    throw new ImapUnsupportedFeatureError("checking whether a reply was sent");
  }

  async countMessages(): Promise<number> {
    throw new ImapUnsupportedFeatureError("counting messages across folders");
  }

  async countReceivedMessages(): Promise<number> {
    throw new ImapUnsupportedFeatureError("counting received messages");
  }

  async createAutoArchiveFilter(): Promise<{ status: number }> {
    throw new ImapUnsupportedFeatureError("server-side filters");
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
    const folderId = await this.resolveDraftFolderId();
    if (!folderId) {
      throw new ImapUnsupportedFeatureError(
        "a Drafts mailbox to keep drafts in",
      );
    }

    const thread = await this.resolveDraftThread(params.replyToMessageId);
    const messageId = createImapDraftMessageId(this.options.email);
    const source = buildImapDraftSource({
      from: { address: params.from ?? this.options.email },
      to: splitAddresses(params.to)?.map(toDraftAddress) ?? [],
      cc: splitAddresses(params.cc)?.map(toDraftAddress),
      bcc: splitAddresses(params.bcc)?.map(toDraftAddress),
      subject: params.subject,
      html: params.messageHtml,
      messageId,
      inReplyTo: thread.inReplyTo,
      references: thread.references,
    });

    await this.withClient((client) =>
      appendImapDraft({ client, folderId, source }),
    );

    return { id: messageId };
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
    const current = await this.readImapDraft(draftId);
    if (!current) throw new SafeError(`Draft ${draftId} was not found`);

    await this.rewriteImapDraft({
      draftId,
      message: current,
      to: params.to,
      from: params.from,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject ?? current.subject,
      html: params.messageHtml ?? current.textHtml ?? "",
      attachments: await this.readImapDraftFiles(draftId),
    });
  }

  async addDraftAttachment(
    draftId: string,
    attachment: DraftAttachmentMetadata & { content: Buffer },
  ): Promise<DraftAttachmentsResult & { attachmentId: string }> {
    const current = await this.readImapDraft(draftId);
    if (!current) {
      throw new DraftNotFoundError(
        "Could not find this draft in your mailbox.",
      );
    }

    const listed = await this.getDraftAttachments(draftId);
    assertDraftAttachmentLimits(
      listed?.attachments.map((file) => ({ size: file.size })) ?? [],
      attachment.size,
    );

    // The Content-ID is what identifies the file across a rewrite, so the one
    // the app sent is kept when it has one.
    const contentId = attachment.contentId ?? `${attachment.id}@draft`;

    await this.rewriteImapDraft({
      draftId,
      message: current,
      to: current.headers.to,
      subject: current.subject,
      html: current.textHtml ?? "",
      attachments: [
        ...(await this.readImapDraftFiles(draftId)),
        {
          filename: attachment.filename,
          contentType: attachment.mimeType,
          content: attachment.content,
          contentId,
        },
      ],
    });

    const result = await this.getDraftAttachments(draftId);
    if (!result) {
      throw new DraftNotFoundError(
        "Could not find this draft in your mailbox.",
      );
    }

    return { ...result, attachmentId: contentId };
  }

  async removeDraftAttachment(
    draftId: string,
    attachmentId: string,
  ): Promise<DraftAttachmentsResult> {
    const current = await this.readImapDraft(draftId);
    if (!current) {
      throw new DraftNotFoundError(
        "Could not find this draft in your mailbox.",
      );
    }

    const files = (await this.readImapDraftFiles(draftId)).filter(
      (file) => file.contentId !== attachmentId,
    );

    await this.rewriteImapDraft({
      draftId,
      message: current,
      to: current.headers.to,
      subject: current.subject,
      html: current.textHtml ?? "",
      attachments: files,
    });

    const result = await this.getDraftAttachments(draftId);
    if (!result) {
      throw new DraftNotFoundError(
        "Could not find this draft in your mailbox.",
      );
    }

    return result;
  }

  async deleteDraft(draftId: string): Promise<boolean> {
    const draft = await this.readImapDraft(draftId);
    if (!draft) return false;

    await this.withClient(async (client) => {
      const folderId = await this.resolveDraftFolderId();
      if (!folderId) return;
      await this.removeImapDraftCopy(client, folderId, draft.id);
    });

    return true;
  }

  async getDraft(
    draftId: string,
    options?: { includeAttachments?: boolean },
  ): Promise<ParsedMessage | null> {
    const draft = await this.readImapDraft(draftId);
    if (!draft) return null;
    if (options?.includeAttachments === false) {
      return { ...draft, attachments: undefined, inline: [] };
    }
    return draft;
  }

  async getDrafts(options?: { maxResults?: number }): Promise<ParsedMessage[]> {
    const folderId = await this.resolveDraftFolderId();
    if (!folderId) return [];

    return this.withClient(async (client) => {
      const { messages } = await listImapMessages({
        client,
        folderId,
        limit: options?.maxResults ?? 50,
        accountEmail: this.options.email,
      });

      return messages;
    });
  }

  async getDraftReferenceForMessage(
    messageId: string,
  ): Promise<DraftReference | null> {
    // Only a message in the Drafts mailbox is a draft, and only then does the
    // app get a reference it can act on.
    const { folderId } = parseImapMessageId(messageId);
    const draftsFolder = await this.resolveDraftFolderId();
    if (!draftsFolder || folderId !== draftsFolder) return null;

    const message = await this.getMessage(messageId);
    const messageIdHeader = message.headers["message-id"];
    if (!messageIdHeader) return null;

    return { id: stripMessageIdBrackets(messageIdHeader) };
  }

  async getDraftAttachments(
    draftId: string,
  ): Promise<DraftAttachmentsResult | null> {
    const draft = await this.readImapDraft(draftId);
    if (!draft) return null;

    // The files are read from the source rather than from the parsed message,
    // because the Content-ID is what identifies a file across a rewrite.
    const files = await this.readImapDraftFiles(draftId);

    return {
      messageId: draftId,
      attachments: files.map((file, index) => ({
        id: file.contentId ?? `${draftId}-${index}`,
        filename: file.filename,
        mimeType: file.contentType ?? "application/octet-stream",
        size: file.content.byteLength,
        disposition: "attachment" as const,
        contentId: file.contentId,
        messageId: draftId,
        providerAttachmentId: file.contentId ?? `${draftId}-${index}`,
      })),
    };
  }

  async sendDraft(
    draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    const draft = await this.readImapDraft(draftId);
    if (!draft) throw new SafeError(`Draft ${draftId} was not found`);

    const sent = await this.deliver({
      to: draft.headers.to ?? "",
      cc: draft.headers.cc,
      bcc: draft.headers.bcc,
      subject: draft.subject,
      html: draft.textHtml ?? draft.textPlain ?? "",
      text: draft.textPlain,
      inReplyTo: draft.headers["in-reply-to"],
      references: splitMessageIds(draft.headers.references),
    });

    // The sent copy replaces the draft, as it does in every mail client.
    await this.deleteDraft(draftId);

    return { messageId: sent.messageId, threadId: sent.threadId };
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
      subject:
        args.subject ||
        (email.subject.toLowerCase().startsWith("re:")
          ? email.subject
          : `Re: ${email.subject}`),
      messageHtml: args.content,
      replyToMessageId: email.id,
    });

    return { draftId: created.id };
  }

  /**
   * Rewrites a draft and removes the copy it replaces.
   *
   * IMAP cannot edit a message, so a changed draft is a new message with the
   * same Message-ID. The app holds the draft by that Message-ID, so the id
   * survives the rewrite and the user sees one draft rather than two.
   */
  private async rewriteImapDraft({
    draftId,
    message,
    to,
    from,
    cc,
    bcc,
    subject,
    html,
    attachments,
  }: {
    draftId: string;
    message: ParsedMessage;
    to?: string;
    from?: string;
    cc?: string;
    bcc?: string;
    subject: string;
    html: string;
    attachments: ImapDraftAttachment[];
  }) {
    const folderId = await this.resolveDraftFolderId();
    if (!folderId) {
      throw new ImapUnsupportedFeatureError(
        "a Drafts mailbox to keep drafts in",
      );
    }

    const source = buildImapDraftSource({
      from: { address: from ?? this.options.email },
      to: splitAddresses(to)?.map(toDraftAddress) ?? [],
      cc: splitAddresses(cc)?.map(toDraftAddress),
      bcc: splitAddresses(bcc)?.map(toDraftAddress),
      subject,
      html,
      messageId: draftId,
      inReplyTo: message.headers["in-reply-to"],
      references: splitMessageIds(message.headers.references),
      attachments,
    });

    await this.withClient(async (client) => {
      await appendImapDraft({ client, folderId, source });
      await this.removeImapDraftCopy(client, folderId, message.id);
    });
  }

  /**
   * Reads a draft by the Message-ID the app holds it by.
   *
   * The draft is found in the Drafts mailbox and hydrated, so the body and the
   * attachments are there.
   */
  private async readImapDraft(draftId: string): Promise<ParsedMessage | null> {
    const folderId = await this.resolveDraftFolderId();
    if (!folderId) return null;

    return this.withClient(async (client) => {
      const uid = await findImapDraftUid({
        client,
        folderId,
        messageId: draftId,
      });
      if (!uid) return null;

      return hydrateImapMessage({
        client,
        folderId,
        uid,
        accountEmail: this.options.email,
      });
    });
  }

  /**
   * The files already on a draft, as bytes.
   *
   * A draft the user made in another client can carry attachments, and
   * rewriting the text of such a draft must not drop them. The parsed message
   * only carries their metadata, so the source is read for the bytes.
   */
  private async readImapDraftFiles(
    draftId: string,
  ): Promise<ImapDraftAttachment[]> {
    const folderId = await this.resolveDraftFolderId();
    if (!folderId) return [];

    return this.withClient(async (client) => {
      const uid = await findImapDraftUid({
        client,
        folderId,
        messageId: draftId,
      });
      if (!uid) return [];

      const source = await this.readImapDraftSource(client, folderId, uid);
      if (!source) return [];

      return readImapDraftAttachments(source);
    });
  }

  /** The raw source of a draft, which is where its attachments live. */
  private async readImapDraftSource(
    client: ImapFlow,
    folderId: string,
    uid: number,
  ): Promise<Buffer | null> {
    const lock = await client.getMailboxLock(folderId);

    try {
      const fetched = await client.fetchOne(
        String(uid),
        { source: true },
        { uid: true },
      );
      // Two checks rather than an optional chain: the fetched value is a union
      // that includes `false`, which an optional chain does not narrow.
      if (!fetched) return null;
      if (!fetched.source) return null;
      return Buffer.isBuffer(fetched.source)
        ? fetched.source
        : Buffer.from(fetched.source as Uint8Array);
    } finally {
      lock.release();
    }
  }

  /**
   * Removes a copy of a draft.
   *
   * IMAP cannot rewrite a message, so the copy that was replaced is moved to
   * the trash like any other message the user deletes. A server with no trash
   * mailbox falls back to the deleted flag, which is what the specification
   * asks for and what mail clients hide.
   */
  private async removeImapDraftCopy(
    client: ImapFlow,
    folderId: string,
    messageId: string,
  ) {
    const { uid } = parseImapMessageId(messageId);
    const lock = await client.getMailboxLock(folderId);

    try {
      const folders = await resolveImapFolders(client);
      if (folders.trash && folders.trash !== folderId) {
        await client.messageMove(String(uid), folders.trash, { uid: true });
        return;
      }
      await client.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
  }

  /**
   * The threading headers a reply draft has to carry.
   *
   * The message being replied to is a message id here, so its own Message-ID
   * has to be read before the draft can point at it.
   */
  private async resolveDraftThread(replyToMessageId?: string) {
    if (!replyToMessageId) return {};

    const message = await this.getMessage(replyToMessageId);
    const inReplyTo = message.headers["message-id"];
    if (!inReplyTo) return {};

    return {
      inReplyTo,
      references: [...splitMessageIds(message.headers.references), inReplyTo],
    };
  }

  async createFilter(): Promise<{ status: number }> {
    throw new ImapUnsupportedFeatureError("server-side filters");
  }

  async createLabel(): Promise<EmailLabel> {
    throw new ImapUnsupportedFeatureError("creating folders");
  }

  async deleteFilter(): Promise<{ status: number }> {
    throw new ImapUnsupportedFeatureError("server-side filters");
  }

  async deleteFolder(): Promise<void> {
    throw new ImapUnsupportedFeatureError("deleting folders");
  }

  async deleteLabel(): Promise<void> {
    throw new ImapUnsupportedFeatureError("deleting folders");
  }

  async forwardEmail(): Promise<{ messageId: string }> {
    throw new ImapUnsupportedFeatureError("forwarding as its own message");
  }

  async getContactPhotos(): Promise<Record<string, string>> {
    // IMAP carries no address book, so there are no photos to read.
    return {};
  }

  async getFiltersList(): Promise<EmailFilter[]> {
    // Empty rather than a refusal: a server with no filter API simply has none,
    // and the assessment reads this as "no filters" rather than an error.
    return [];
  }

  async getForwardingAddresses(): Promise<string[]> {
    return [];
  }

  async getInboxMessages(maxResults?: number) {
    const { messages } = await this.getMessagesWithPagination({
      folderId: "INBOX",
      maxResults,
    });
    return messages;
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    const matches = await this.searchThreadMessages(rfc822MessageId);
    return matches[0] ?? null;
  }

  async getMessagesFromSender(): ReturnType<
    EmailProvider["getMessagesFromSender"]
  > {
    throw new ImapUnsupportedFeatureError("searching by sender");
  }

  async getMessagesWithAttachments(): ReturnType<
    EmailProvider["getMessagesWithAttachments"]
  > {
    throw new ImapUnsupportedFeatureError("searching by attachment");
  }

  async getOrCreateFolderIdByName(): Promise<string> {
    throw new ImapUnsupportedFeatureError("creating folders");
  }

  async getOrCreateBrandLabel(): Promise<EmailLabel> {
    throw new ImapUnsupportedFeatureError("creating folders");
  }

  async getOriginalMessage(): Promise<ParsedMessage | null> {
    return null;
  }

  async getPreviousConversationMessages(): Promise<ParsedMessage[]> {
    return [];
  }

  async getSendAsAddresses(): Promise<SendAsAddress[]> {
    // IMAP cannot enumerate the account's aliases; mail goes out as the account.
    return [];
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
    pageToken?: string;
  }): Promise<SentMessagePage> {
    const sentFolderId = await this.resolveSentFolderId();
    if (!sentFolderId) return { messages: [], nextPageToken: undefined };

    const page = await this.getMessagesWithPagination({
      folderId: sentFolderId,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });

    return {
      messages: page.messages.map((message) => ({
        id: message.id,
        threadId: message.threadId,
      })),
      nextPageToken: page.nextPageToken,
    };
  }

  async getSentMessages(maxResults?: number) {
    try {
      const sentFolderId = await this.resolveSentFolderId();
      if (!sentFolderId) return [];

      const { messages } = await this.getMessagesWithPagination({
        folderId: sentFolderId,
        maxResults,
      });
      return messages;
    } catch {
      return [];
    }
  }

  async getSentThreadsExcluding(): Promise<EmailThread[]> {
    throw new ImapUnsupportedFeatureError("filtering sent threads");
  }

  async getSignatures(): Promise<EmailSignature[]> {
    // Signatures live in the provider's web settings, which IMAP does not expose.
    return [];
  }

  async getThreadMessagesInInbox(threadId: string) {
    return this.getThreadMessages(threadId);
  }

  async getThreads(): Promise<EmailThread[]> {
    throw new ImapUnsupportedFeatureError("listing conversations");
  }

  async getThreadsFromSenderWithSubject(): Promise<
    Array<{ id: string; snippet: string; subject: string }>
  > {
    throw new ImapUnsupportedFeatureError("searching by sender");
  }

  async getThreadsWithLabel(): Promise<EmailThread[]> {
    throw new ImapUnsupportedFeatureError("listing conversations by folder");
  }

  async getThreadsWithParticipant(): Promise<EmailThread[]> {
    throw new ImapUnsupportedFeatureError("searching by participant");
  }

  async getThreadsWithQuery(): Promise<{
    threads: EmailThread[];
    nextPageToken?: string;
  }> {
    throw new ImapUnsupportedFeatureError("searching conversations");
  }

  async hasPreviousCommunicationsWithSenderOrDomain(): Promise<boolean> {
    throw new ImapUnsupportedFeatureError("searching by sender");
  }

  async labelMessage(): Promise<{
    usedFallback?: boolean;
    actualLabelId?: string;
  }> {
    throw new ImapUnsupportedFeatureError("labels");
  }

  async moveThreadToFolder(): Promise<void> {
    throw new ImapUnsupportedFeatureError("moving to an arbitrary folder");
  }

  async removeThreadLabel(): Promise<void> {
    throw new ImapUnsupportedFeatureError("labels");
  }

  async removeThreadLabels(): Promise<void> {
    throw new ImapUnsupportedFeatureError("labels");
  }

  async renameFolder(): Promise<void> {
    throw new ImapUnsupportedFeatureError("renaming folders");
  }

  async searchContacts(): Promise<EmailContact[]> {
    // No address book over IMAP, so compose offers no suggestions.
    return [];
  }

  async searchMessages(): ReturnType<EmailProvider["searchMessages"]> {
    throw new ImapUnsupportedFeatureError("searching the mailbox");
  }

  async searchThreads(): Promise<{
    threads: EmailThread[];
    nextPageToken?: string;
  }> {
    throw new ImapUnsupportedFeatureError("searching conversations");
  }

  async startDraftAttachmentUpload(): Promise<DraftAttachmentUploadStart> {
    // IMAP has no upload session, so a file can only be attached by sending
    // its bytes with the rest of the draft.
    throw new ImapUnsupportedFeatureError(
      `attaching files larger than ${Math.round(DRAFT_ATTACHMENT_DIRECT_UPLOAD_LIMIT_BYTES / (1024 * 1024))} MB`,
    );
  }

  async updateLabel(): Promise<void> {
    throw new ImapUnsupportedFeatureError("renaming folders");
  }
}

/**
 * A message id carries the mailbox it lives in, because an IMAP UID is only
 * unique inside one mailbox.
 */
export function toImapMessageId(uid: number, folderId: string) {
  return `${folderId}:${uid}`;
}

export function parseImapMessageId(messageId: string) {
  const separator = messageId.lastIndexOf(":");
  const folderId = separator === -1 ? "INBOX" : messageId.slice(0, separator);
  const uid = Number(
    separator === -1 ? messageId : messageId.slice(separator + 1),
  );

  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SafeError(`Invalid IMAP message id: ${messageId}`);
  }

  return { folderId, uid };
}

function splitAddresses(value?: string) {
  if (!value) return;
  const addresses = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return addresses.length ? addresses : undefined;
}

/** An address for a draft header, split into its name and its address. */
function toDraftAddress(value: string): ImapDraftAddress {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { address: value };
  return { name: match[1].replace(/^"|"$/g, ""), address: match[2] };
}

/** The message ids in a `References` header, without their angle brackets. */
function splitMessageIds(value?: string) {
  if (!value) return [];
  return (value.match(/<[^>]+>/g) ?? []).map((entry) =>
    stripMessageIdBrackets(entry),
  );
}

/** A Message-ID without the angle brackets the header carries it in. */
function stripMessageIdBrackets(value: string) {
  return value.replace(/^</, "").replace(/>$/, "");
}
