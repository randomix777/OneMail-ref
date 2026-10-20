import { resolveMailTransport } from "@/utils/email/provider-registry";
import { isNylasErrorWithStatus, nylasFetch } from "@/utils/nylas/client";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * The provider family whose mailboxes cost money.
 *
 * Google mail is reached through a paid broker, so it is the one family a
 * subscription covers. The other families connect straight to their provider
 * and cost us nothing, which is why they are left alone when a subscription
 * ends.
 */
const PAID_PROVIDER = "google";

export type RevokeOutcome = "revoked" | "already-gone" | "not-connected";

/**
 * Cuts a mailbox off from the provider that holds its credentials.
 *
 * The mailbox keeps its messages and its place in the app; what goes away is
 * the provider connection, so the app asks for a reconnect before mail flows
 * again. That is the shape a cancelled subscription needs: the customer stops
 * paying, the provider stops billing us, and coming back is one click of
 * consent rather than a migration.
 */
export async function revokeMailboxConnection({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}): Promise<RevokeOutcome> {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      id: true,
      account: {
        select: {
          id: true,
          provider: true,
          transport: true,
          providerAccountId: true,
          refresh_token: true,
          disconnectedAt: true,
        },
      },
    },
  });

  const account = emailAccount?.account;
  if (!account) return "not-connected";
  if (account.disconnectedAt) return "already-gone";

  const transport = resolveMailTransport(account.provider, account.transport);

  if (transport === "nylas") {
    await deleteNylasGrantById({
      grantId: account.providerAccountId,
      logger,
    });
  } else if (account.provider === "google") {
    await revokeGoogleToken({
      refreshToken: account.refresh_token,
      logger,
    });
  }

  await prisma.account.update({
    where: { id: account.id },
    data: {
      disconnectedAt: new Date(),
      refresh_token: null,
      access_token: null,
      expires_at: null,
      refreshTokenExpiresAt: null,
    },
  });

  logger.info("Revoked the provider connection of a paid mailbox");

  return "revoked";
}

/**
 * Cuts off every paid mailbox a subscription was covering.
 *
 * Only the paid family is touched. The free families cost nothing, so a
 * customer who cancels keeps the mailboxes that were never part of the bill.
 */
export async function revokePaidMailboxesForPremium({
  customerId,
  logger,
}: {
  customerId: string;
  logger: Logger;
}): Promise<{ revoked: number; skipped: number }> {
  const premium = await prisma.premium.findUnique({
    where: { stripeCustomerId: customerId },
    select: {
      users: { select: { id: true } },
      admins: { select: { id: true } },
    },
  });

  if (!premium) return { revoked: 0, skipped: 0 };

  const userIds = [
    ...new Set([
      ...premium.users.map((user) => user.id),
      ...premium.admins.map((admin) => admin.id),
    ]),
  ];
  if (!userIds.length) return { revoked: 0, skipped: 0 };

  const mailboxes = await prisma.emailAccount.findMany({
    where: {
      userId: { in: userIds },
      account: { provider: PAID_PROVIDER, disconnectedAt: null },
    },
    select: { id: true },
  });

  let revoked = 0;
  for (const mailbox of mailboxes) {
    const outcome = await revokeMailboxConnection({
      emailAccountId: mailbox.id,
      logger,
    });
    if (outcome === "revoked") revoked += 1;
  }

  return { revoked, skipped: mailboxes.length - revoked };
}

/**
 * Deletes the broker's grant, which is what makes the account stop counting
 * against the broker's plan.
 *
 * A grant that is already gone is not an error: the goal is that it does not
 * exist, and it does not.
 */
export async function deleteNylasGrantById({
  grantId,
  logger,
}: {
  grantId: string;
  logger: Logger;
}) {
  try {
    await nylasFetch({
      path: `/grants/${encodeURIComponent(grantId)}`,
      method: "DELETE",
    });
  } catch (error) {
    if (isNylasErrorWithStatus(error, 404)) {
      logger.info("The broker grant was already gone");
      return;
    }
    throw error;
  }
}

/**
 * Revokes the refresh token at the provider.
 *
 * Without this the token stays valid at Google even after we drop it, so the
 * customer would still have granted us access they never asked to give up.
 */
async function revokeGoogleToken({
  refreshToken,
  logger,
}: {
  refreshToken: string | null;
  logger: Logger;
}) {
  if (!refreshToken) return;

  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  });

  if (!response.ok) {
    logger.warn("The provider refused to revoke a refresh token", {
      status: response.status,
    });
  }
}
