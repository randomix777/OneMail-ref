import prisma from "@/utils/prisma";
import {
  resolveMailTransport,
  type MailTransport,
} from "@/utils/email/provider-registry";

export type MailboxTransportContext = {
  transport: MailTransport;
  /** The Nylas grant id for a `nylas` mailbox; null for every other transport. */
  providerAccountId: string | null;
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
      account: { select: { transport: true, providerAccountId: true } },
    },
  });

  const account = emailAccount?.account;

  return {
    transport: resolveMailTransport(provider, account?.transport),
    providerAccountId: account?.providerAccountId ?? null,
  };
}
