import type { ImapFlow } from "imapflow";
import {
  decodeMailboxSyncCursor,
  encodeMailboxSyncCursor,
  InvalidMailboxSyncCursorError,
} from "@/utils/email/mailbox-sync";
import type { MailboxSyncPage } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import {
  getUidValidity,
  listImapMailboxes,
  resolveMailboxRoles,
} from "./client";
import { applyImapSource, toParsedMessage } from "./mime";

/** Flags a message list needs to derive read/starred/draft state. */
const SUMMARY_FETCH_QUERY = {
  uid: true,
  envelope: true,
  flags: true,
  internalDate: true,
  size: true,
} as const;

/**
 * A page of messages in one mailbox, newest first.
 *
 * IMAP addresses messages by UID inside a mailbox, so `folderId` is required
 * rather than optional: there is no mailbox-wide sequence to page over.
 */
export async function listImapMessages({
  client,
  folderId,
  limit,
  pageToken,
  accountEmail,
}: {
  client: ImapFlow;
  folderId: string;
  limit: number;
  pageToken?: string;
  accountEmail: string;
}) {
  const lock = await client.getMailboxLock(folderId);

  try {
    // `*` is the highest UID; counting backwards from it is how a newest-first
    // page is requested without knowing the mailbox size.
    const highestUid = client.mailbox ? client.mailbox.uidNext - 1 : 0;
    if (highestUid <= 0) return { messages: [], nextPageToken: undefined };

    const end = pageToken ? Number(pageToken) : highestUid;
    if (!Number.isFinite(end) || end <= 0) {
      throw new InvalidMailboxSyncCursorError();
    }
    const start = Math.max(1, end - limit + 1);

    const messages = [];
    for await (const fetched of client.fetch(
      { uid: `${start}:${end}` },
      SUMMARY_FETCH_QUERY,
    )) {
      messages.push({
        ...toParsedMessage(
          {
            uid: fetched.uid,
            envelope: fetched.envelope,
            internalDate: fetched.internalDate,
            size: fetched.size,
            flags: fetched.flags,
            folderId,
          },
          accountEmail,
        ),
        // Newest first, which is the order a list view expects.
      });
    }

    messages.sort((left, right) =>
      right.internalDate!.localeCompare(left.internalDate!),
    );

    return {
      messages,
      nextPageToken: start > 1 ? String(start - 1) : undefined,
    };
  } finally {
    lock.release();
  }
}

/**
 * The delta for one mailbox since the last UID we saw.
 *
 * IMAP's version of a change log is `UID n:*`. Two things make that safe:
 *
 * - The cursor carries the mailbox's UIDVALIDITY. A server that renumbers a
 *   mailbox makes every stored UID meaningless, so a changed generation resets
 *   instead of reporting an empty delta.
 * - `n:*` always returns at least the message with UID `n`, so the *last* UID is
 *   re-reported every time. It is filtered out here rather than trusted to the
 *   caller, or every poll would re-insert the newest message.
 */
export async function getImapMailboxSyncPage({
  client,
  folderId,
  cursor,
  after,
  limit,
  accountEmail,
}: {
  client: ImapFlow;
  folderId: string;
  cursor?: string;
  after?: Date;
  limit: number;
  accountEmail: string;
}): Promise<MailboxSyncPage> {
  const uidValidity = await getUidValidity(client, folderId);
  if (!uidValidity) {
    // Nothing to version by, so a delta cannot be trusted; ask for a full read.
    return {
      cursor: "",
      deletedMessageIds: [],
      hasMore: false,
      reset: true,
      upsertedMessages: [],
    };
  }

  const decoded = cursor ? decodeMailboxSyncCursor(cursor, "imap") : null;

  if (
    decoded &&
    (decoded.folderId !== folderId || decoded.uidValidity !== uidValidity)
  ) {
    // Either the folder changed under us or the server renumbered it; both mean
    // every stored UID is stale.
    return {
      cursor: "",
      deletedMessageIds: [],
      hasMore: false,
      reset: true,
      upsertedMessages: [],
    };
  }

  const sinceUid = decoded?.lastUid ?? 0;
  const lock = await client.getMailboxLock(folderId);

  try {
    const range = sinceUid > 0 ? `${sinceUid + 1}:*` : "1:*";
    // UIDs are tracked beside the messages rather than read back out of them:
    // a message id is namespaced by mailbox (`INBOX:12`), so parsing it into a
    // number would yield NaN.
    const collected: Array<{ uid: number; message: ParsedMessage }> = [];
    let highest = sinceUid;

    for await (const fetched of client.fetch(
      { uid: range },
      SUMMARY_FETCH_QUERY,
    )) {
      if (fetched.uid <= sinceUid) continue;
      highest = Math.max(highest, fetched.uid);
      collected.push({
        uid: fetched.uid,
        message: toParsedMessage(
          {
            uid: fetched.uid,
            envelope: fetched.envelope,
            internalDate: fetched.internalDate,
            size: fetched.size,
            flags: fetched.flags,
            folderId,
          },
          accountEmail,
        ),
      });
    }

    // Trimming keeps one poll from returning an unbounded page.
    const hasMore = collected.length > limit;
    const limited = hasMore ? collected.slice(0, limit) : collected;
    const page = limited.map((entry) => entry.message);
    const lastUid =
      limited.length > 0 ? limited[limited.length - 1].uid : highest;

    return {
      cursor: encodeMailboxSyncCursor({
        version: 1,
        provider: "imap",
        folderId,
        uidValidity,
        lastUid,
        after: (after ?? new Date()).toISOString(),
        phase: "delta",
      }),
      deletedMessageIds: [],
      hasMore,
      reset: false,
      upsertedMessages: page,
    };
  } finally {
    lock.release();
  }
}

/**
 * The full body of one message, by UID.
 *
 * The summary is fetched first so the record keeps its flags and dates, then the
 * source is parsed for the body and attachments.
 */
export async function hydrateImapMessage({
  client,
  folderId,
  uid,
  accountEmail,
}: {
  client: ImapFlow;
  folderId: string;
  uid: number;
  accountEmail: string;
}) {
  const lock = await client.getMailboxLock(folderId);

  try {
    const fetched = await client.fetchOne(
      String(uid),
      { ...SUMMARY_FETCH_QUERY, source: true },
      { uid: true },
    );
    // Two checks rather than !fetched?.source: an optional chain on a union
    // that includes \alse\ does not narrow the value for the reads below.
    if (!fetched) return null;
    if (!fetched.source) return null;

    const summary = toParsedMessage(
      {
        uid: fetched.uid,
        envelope: fetched.envelope,
        internalDate: fetched.internalDate,
        size: fetched.size,
        flags: fetched.flags,
        folderId,
      },
      accountEmail,
    );

    return applyImapSource({ message: summary, source: fetched.source });
  } finally {
    lock.release();
  }
}

/**
 * Conversation membership.
 *
 * IMAP has no thread object, so a thread is resolved the way mail clients have
 * always done it: the `References`/`In-Reply-To` chain. Only messages the caller
 * already knows about can be grouped, because finding the missing members would
 * mean searching every mailbox for a message id.
 */
export function groupImapMessagesIntoThreads(
  messages: {
    messageId: string;
    inReplyTo?: string;
    references?: string;
  }[],
) {
  const parentOf = new Map<string, string>();

  for (const message of messages) {
    const parent = lastReferenceId(message.references) ?? message.inReplyTo;
    if (parent) parentOf.set(message.messageId, parent);
  }

  const rootCache = new Map<string, string>();

  const assign = (path: string[], root: string) => {
    for (const node of path) rootCache.set(node, root);
    return root;
  };

  const rootOf = (messageId: string) => {
    const path: string[] = [];
    let current = messageId;

    for (;;) {
      const cached = rootCache.get(current);
      if (cached !== undefined) return assign(path, cached);

      // Malformed mail can reference in a loop. Everyone in the loop is still one
      // conversation, so the loop is collapsed onto its lowest id rather than
      // split, and the walk always terminates.
      const cycleAt = path.indexOf(current);
      if (cycleAt !== -1) {
        const root = [...path.slice(cycleAt)].sort()[0];
        return assign(path, root);
      }

      path.push(current);

      const parent = parentOf.get(current);
      if (parent === undefined) return assign(path, current);
      current = parent;
    }
  };

  const threads = new Map<string, string[]>();
  for (const message of messages) {
    const root = rootOf(message.messageId);
    const members = threads.get(root) ?? [];
    members.push(message.messageId);
    threads.set(root, members);
  }

  return threads;
}

function lastReferenceId(references?: string) {
  if (!references) return;
  const ids = references.match(/<[^>]+>/g);
  return ids?.length ? ids[ids.length - 1] : undefined;
}

/**
 * Reads one attachment part.
 *
 * `attachmentId` is the composer's `${messageId}-${index}`, so the index picks
 * the part out of the parsed message instead of assuming IMAP part numbering.
 */
export async function readImapAttachment({
  client,
  folderId,
  uid,
  attachmentId,
  messageId,
  accountEmail,
}: {
  client: ImapFlow;
  folderId: string;
  uid: number;
  attachmentId: string;
  messageId: string;
  accountEmail: string;
}) {
  const message = await hydrateImapMessage({
    client,
    folderId,
    uid,
    accountEmail,
  });
  if (!message) return null;

  const index = Number(attachmentId.slice(messageId.length + 1));
  if (!Number.isInteger(index) || index < 0) return null;

  const attachment = message.attachments?.[index];
  if (!attachment) return null;

  // Re-read the part on its own so the whole message is not held in memory for
  // one file. IMAP parts are numbered from 1 and the parser's index is 0-based.
  const lock = await client.getMailboxLock(folderId);

  try {
    const part = String(index + 1);
    const download = await client.download(String(uid), part, { uid: true });
    if (!("content" in download) || !download.content) return null;
    return download.content;
  } finally {
    lock.release();
  }
}

/**
 * The mailbox paths a folder role maps to, for the caller that has to name one.
 *
 * Roles come from attributes first (see `resolveMailboxRoles`), so a provider
 * that calls its junk folder `Spam` and its archive `Archive` still resolves.
 */
export async function resolveImapFolders(client: ImapFlow) {
  const mailboxes = await listImapMailboxes(client);
  const roles = resolveMailboxRoles(mailboxes);

  return {
    mailboxes,
    byRole: roles,
    sent: roles.get("sent")?.path,
    drafts: roles.get("draft")?.path,
    trash: roles.get("trash")?.path,
    spam: roles.get("spam")?.path,
    archive: roles.get("archive")?.path,
    inbox: roles.get("inbox")?.path,
  };
}
