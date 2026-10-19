import { ImapFlow } from "imapflow";
import type { Logger } from "@/utils/logger";

/**
 * The RFC 9051 / RFC 6154 attributes a mailbox can carry.
 *
 * Roles are read from these attributes rather than from names, because every
 * provider names its folders differently: Fastmail calls it `Spam` where others
 * say `Junk`, and `Archive` where Gmail says `All Mail`. None of Zoho, Yahoo or
 * Fastmail documents SPECIAL-USE for third-party clients, so the name is used
 * only as a fallback and never as the primary signal.
 */
export type ImapMailboxRole =
  | "inbox"
  | "sent"
  | "draft"
  | "trash"
  | "spam"
  | "archive";

export type ImapMailbox = {
  path: string;
  name: string;
  /** RFC 6154 special-use flag, when the server advertises one. */
  specialUse?: string;
  role?: ImapMailboxRole;
  /** True when the role came from a name rather than from an attribute. */
  roleInferred?: boolean;
};

const ROLE_BY_SPECIAL_USE: Record<string, ImapMailboxRole> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "draft",
  "\\trash": "trash",
  "\\junk": "spam",
  "\\archive": "archive",
  "\\all": "archive",
  "\\flagged": "archive",
};

/**
 * Names are a fallback only. Matched lowercase against the leaf name, so
 * `[Gmail]/All Mail` and `INBOX.Sent` both work.
 */
const ROLE_BY_NAME: Record<string, ImapMailboxRole> = {
  inbox: "inbox",
  sent: "sent",
  // Gmail nests it as `[Gmail]/Sent Mail`; Outlook uses "Sent Items"; some hosts
  // say "Sent Messages".
  "sent mail": "sent",
  "sent items": "sent",
  "sent messages": "sent",
  drafts: "draft",
  draft: "draft",
  trash: "trash",
  "deleted items": "trash",
  "deleted messages": "trash",
  junk: "spam",
  spam: "spam",
  archive: "archive",
  "all mail": "archive",
};

/**
 * Chooses the best mailbox for each role.
 *
 * An explicit special-use attribute always wins over a name guess, and a guess is
 * only accepted when it is unambiguous: two mailboxes that both look like `Sent`
 * leave the role unassigned rather than picking one arbitrarily.
 */
export function resolveMailboxRoles(mailboxes: ImapMailbox[]) {
  const byRole = new Map<ImapMailboxRole, ImapMailbox>();
  const ambiguous = new Set<ImapMailboxRole>();

  // Attributes win, and two mailboxes claiming the same attribute leave that
  // role unassigned rather than picking one arbitrarily.
  for (const mailbox of mailboxes) {
    if (!mailbox.role || mailbox.roleInferred) continue;
    if (byRole.has(mailbox.role)) {
      ambiguous.add(mailbox.role);
      continue;
    }
    byRole.set(mailbox.role, mailbox);
  }
  for (const role of ambiguous) byRole.delete(role);

  // Name guesses only fill the gaps the attributes left.
  for (const mailbox of mailboxes) {
    if (!mailbox.role || !mailbox.roleInferred) continue;
    if (byRole.has(mailbox.role)) continue;
    byRole.set(mailbox.role, mailbox);
  }

  return byRole;
}

export function classifyMailbox({
  path,
  name,
  specialUse,
}: {
  path: string;
  name: string;
  specialUse?: string;
}): Pick<ImapMailbox, "role" | "roleInferred"> {
  const attribute = specialUse
    ? ROLE_BY_SPECIAL_USE[specialUse.toLowerCase()]
    : undefined;
  if (attribute) return { role: attribute, roleInferred: false };

  // `INBOX` is case-insensitive by RFC and always exists, so it does not need an
  // attribute to be recognised.
  if (path.toLowerCase() === "inbox") {
    return { role: "inbox", roleInferred: false };
  }

  const leaf = (name || path).split(/[/.]/).pop()?.toLowerCase().trim() ?? "";
  const guessed = ROLE_BY_NAME[leaf];
  return guessed ? { role: guessed, roleInferred: true } : {};
}

export type ImapConnectionOptions = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  secret: string;
  logger: Logger;
};

/**
 * Opens one IMAP connection for the duration of a single unit of work.
 *
 * Deliberately not a pooled long-lived client: Fastmail documents a per-user
 * limit of 500 successful logins per 10 minutes across all services, so the
 * calling side has to be able to keep a connection open across a whole sync
 * rather than log in per message.
 */
export async function withImapConnection<T>(
  options: ImapConnectionOptions,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.username, pass: options.secret },
    // imapflow logs credentials at debug level; keep it silent by default and
    // let our own logger carry the events that matter.
    logger: false,
    // A stuck server must not hold a request open forever.
    socketTimeout: 60_000,
    greetingTimeout: 15_000,
  });

  try {
    await client.connect();
    return await work(client);
  } finally {
    // `logout` closes the session politely; a server that has already dropped us
    // throws here, which must not mask the real error.
    await client.logout().catch(() => undefined);
  }
}

export async function listImapMailboxes(client: ImapFlow) {
  const mailboxes: ImapMailbox[] = [];

  // `list()` resolves to an array; it is not an async iterable.
  for (const listed of await client.list()) {
    const specialUse = listed.specialUse ?? undefined;
    mailboxes.push({
      path: listed.path,
      name: listed.name,
      specialUse,
      ...classifyMailbox({
        path: listed.path,
        name: listed.name,
        specialUse,
      }),
    });
  }

  return mailboxes;
}

/**
 * The UIDVALIDITY generation of a mailbox, or null when the server does not
 * report one.
 *
 * Stored with every cursor because UIDs are only meaningful inside one
 * generation: when this changes, every UID we remember is stale and the right
 * answer is a reset rather than a delta that silently returns nothing. A server
 * that omits the value leaves nothing to version by, which the caller has to
 * treat as "cannot delta" instead of comparing against a made-up number.
 */
export async function getUidValidity(client: ImapFlow, path: string) {
  // `status` answers false when the mailbox cannot be inspected, and the field
  // itself is optional and a bigint.
  const status = await client.status(path, { uidValidity: true });
  if (!status || status.uidValidity === undefined) return null;

  return status.uidValidity.toString();
}
