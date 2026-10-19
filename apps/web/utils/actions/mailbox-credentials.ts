import { actionClientUser } from "@/utils/actions/safe-action";
import {
  connectImapMailboxBody,
  type ConnectImapMailboxBody,
} from "@/utils/actions/mailbox-credentials.validation";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import type { ProviderFamily } from "@/utils/email/provider-registry";
import { isProviderFamily } from "@/utils/email/provider-registry";
import { listImapMailboxes, withImapConnection } from "@/utils/imap/client";
import { getImapPreset } from "@/utils/imap/presets";
import prisma from "@/utils/prisma";

/**
 * Connects a mailbox reached over IMAP/SMTP with an app password.
 *
 * The connection is attempted *before* anything is written: a wrong hostname or
 * a provider that has IMAP switched off should fail with a message about the
 * credentials, not leave a half-created mailbox behind.
 */
export const connectImapMailboxAction = actionClientUser
  .metadata({ name: "connectImapMailbox" })
  .inputSchema(connectImapMailboxBody)
  .action(async ({ ctx: { userId, logger }, parsedInput }) => {
    const family = parsedInput.provider;
    if (!isProviderFamily(family)) {
      throw new SafeError(`Unsupported provider: ${family}`);
    }

    const connection = resolveConnection({ input: parsedInput, family });

    await assertImapReachable({ connection, logger });

    const existing = await prisma.emailAccount.findUnique({
      where: { email: parsedInput.email },
      select: { id: true, userId: true },
    });

    if (existing) {
      if (existing.userId !== userId) {
        throw new SafeError(
          "This mailbox is already connected to another account.",
        );
      }

      // Reconnecting updates the stored secret rather than adding a second
      // mailbox, which is also what the unique email address requires.
      await prisma.mailboxCredential.upsert({
        where: { emailAccountId: existing.id },
        create: {
          emailAccountId: existing.id,
          ...credentialData(family, connection),
        },
        update: credentialData(family, connection),
      });

      logger.info("Reconnected an IMAP mailbox");

      return { emailAccountId: existing.id, created: false };
    }

    const account = await prisma.account.create({
      data: {
        userId,
        type: "oidc",
        provider: family,
        // IMAP has no provider-side account id; the address is unique per
        // provider and satisfies the unique constraint.
        providerAccountId: parsedInput.email,
        transport: "imap",
        emailAccount: {
          create: {
            email: parsedInput.email,
            userId,
          },
        },
      },
      select: { emailAccount: { select: { id: true } } },
    });

    const emailAccountId = account.emailAccount?.id;
    if (!emailAccountId) {
      throw new SafeError("The mailbox could not be created.");
    }

    await prisma.mailboxCredential.create({
      data: {
        emailAccountId,
        ...credentialData(family, connection),
      },
    });

    logger.info("Connected an IMAP mailbox", { provider: family });

    return { emailAccountId, created: true };
  });

type ResolvedConnection = {
  secret: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
};

export function resolveConnection({
  input,
  family,
}: {
  input: ConnectImapMailboxBody;
  family: ProviderFamily;
}): ResolvedConnection {
  const preset = getImapPreset(family);

  const imapHost = input.imapHost ?? preset?.imapHost;
  const imapPort = input.imapPort ?? preset?.imapPort;
  const smtpHost = input.smtpHost ?? preset?.smtpHost;
  const smtpPort = input.smtpPort ?? preset?.smtpPort;

  if (!imapHost || !imapPort || !smtpHost || !smtpPort) {
    throw new SafeError(
      "The mail server's IMAP and SMTP details are required for this provider.",
    );
  }

  return {
    // The password goes with the rest of the connection so the reachability
    // check and the stored row cannot disagree about it.
    secret: input.secret,
    imapHost,
    imapPort,
    // A preset owns the TLS mode, because the port and the mode have to agree:
    // iCloud documents STARTTLS on 587 for SMTP, and a form default of "secure"
    // would silently wrap that port in implicit TLS and fail every send.
    imapSecure: preset ? preset.imapSecure : (input.imapSecure ?? true),
    smtpHost,
    smtpPort,
    smtpSecure: preset ? preset.smtpSecure : (input.smtpSecure ?? true),
    // Most hosts accept the full address; a few want a bare username, which the
    // form lets the user override.
    username: input.username ?? input.email,
  };
}

function credentialData(
  family: ProviderFamily,
  connection: ResolvedConnection,
) {
  return {
    provider: family,
    active: true,
    imapHost: connection.imapHost,
    imapPort: connection.imapPort,
    imapSecure: connection.imapSecure,
    smtpHost: connection.smtpHost,
    smtpPort: connection.smtpPort,
    smtpSecure: connection.smtpSecure,
    username: connection.username,
    authType: "password" as const,
    // The Prisma extension encrypts this field on write and decrypts on read.
    secret: connection.secret,
  };
}

/**
 * Logs in and lists folders, which is the cheapest proof that the host, the port
 * and the password all work.
 */
async function assertImapReachable({
  connection,
  logger,
}: {
  connection: ResolvedConnection;
  logger: Logger;
}) {
  try {
    await withImapConnection(
      {
        host: connection.imapHost,
        port: connection.imapPort,
        secure: connection.imapSecure,
        username: connection.username,
        secret: connection.secret,
        logger,
      },
      async (client) => {
        await listImapMailboxes(client);
      },
    );
  } catch (error) {
    // The cause stays in the log: `SafeError` only carries the message the user
    // is allowed to see, and a server's own text can name internal hosts.
    logger.warn("IMAP connection test failed", {
      host: connection.imapHost,
      port: connection.imapPort,
      error,
    });

    throw new SafeError(
      "Could not sign in to that mail server. Check the hostname, the port and the app password.",
    );
  }
}
