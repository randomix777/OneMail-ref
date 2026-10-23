"use server";

import { actionClientUser } from "@/utils/actions/safe-action";
import { connectImapMailboxBody } from "@/utils/actions/mailbox-credentials.validation";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import type { ProviderFamily } from "@/utils/email/provider-registry";
import { isProviderFamily } from "@/utils/email/provider-registry";
import { listImapMailboxes, withImapConnection } from "@/utils/imap/client";
import {
  resolveConnection,
  type ResolvedConnection,
} from "@/utils/actions/mailbox-credentials.helpers";
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
      select: {
        id: true,
        userId: true,
        account: { select: { provider: true } },
      },
    });

    if (existing) {
      if (existing.userId !== userId) {
        throw new SafeError(
          "This mailbox is already connected to another account.",
        );
      }

      // The same address cannot be two providers at once here, but a row that
      // disagrees is a state we should not quietly change the credentials of.
      if (existing.account?.provider !== family) {
        throw new SafeError(
          `This mailbox is already connected as ${existing.account?.provider ?? "another provider"}. Remove it before connecting it as ${family}.`,
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
