import prisma from "@/utils/prisma";
import {
  resolveMailTransport,
  type MailTransport,
} from "@/utils/email/provider-registry";

export type MailboxTransportContext = {
  transport: MailTransport;
  /** The mailbox's own address, which is the default From for some transports. */
  email: string | null;
  /** The Nylas grant id for a `nylas` mailbox; null for every other transport. */
  providerAccountId: string | null;
  /** The connection details for an `imap` mailbox; null for every other transport. */
  credential: MailboxCredentialContext | null;
};

export type MailboxCredentialContext = {
  provider: string;
  active: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  secret: string | null;
};

/**
 * How we reach a mailbox, and the identifier that transport needs.
 *
 * The account row is the source of truth; a missing or unrecognized transport
 * falls back to the family's default so accounts created before the column
 * existed keep working. This is read on every provider construction, so it is a
 * single query rather than one per fact.
 */
export async function getMailboxTransportContext({
  emailAccountId,
  provider,
}: {
  emailAccountId: string;
  provider: string;
}): Promise<MailboxTransportContext> {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      email: true,
      account: { select: { transport: true, providerAccountId: true } },
      mailboxCredential: {
        select: {
          provider: true,
          active: true,
          imapHost: true,
          imapPort: true,
          imapSecure: true,
          smtpHost: true,
          smtpPort: true,
          smtpSecure: true,
          username: true,
          secret: true,
        },
      },
    },
  });

  const account = emailAccount?.account;
  const transport = resolveMailTransport(provider, account?.transport);
  const credential =
    transport === "imap" ? (emailAccount?.mailboxCredential ?? null) : null;

  return {
    transport,
    email: emailAccount?.email ?? null,
    providerAccountId: account?.providerAccountId ?? null,
    // Withheld unless the transport needs it, so a plain OAuth mailbox never
    // carries an app password around in memory.
    credential,
  };
}
