import sumBy from "lodash/sumBy";
import { updateSubscriptionItemQuantity } from "@/ee/billing/lemon/index";
import { updateStripeSubscriptionItemQuantity } from "@/ee/billing/stripe/index";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("premium");

/**
 * The provider family whose mailboxes are billed.
 *
 * Google mail goes through Nylas, so it is the one family that costs money to
 * read. The rest connect straight to the provider.
 */
const BILLABLE_PROVIDER = "google";

export async function updateAccountSeats({ userId }: { userId: string }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { premium: { select: { id: true } } },
  });

  if (!user) throw new Error(`User not found for id ${userId}`);

  if (!user.premium) {
    logger.warn("User has no premium", { userId });
    return;
  }

  await syncPremiumSeats(user.premium.id);
}

export async function syncPremiumSeats(premiumId: string) {
  const premium = await prisma.premium.findUnique({
    where: { id: premiumId },
    select: {
      lemonSqueezySubscriptionItemId: true,
      stripeSubscriptionItemId: true,
      stripePriceId: true,
      users: {
        select: {
          emailAccounts: {
            select: { account: { select: { provider: true } } },
          },
        },
      },
    },
  });

  if (!premium) {
    logger.warn("Premium not found", { premiumId });
    return;
  }

  const totalSeats = getStripeBillingQuantity({
    users: premium.users,
  });
  await updateAccountSeatsForPremium(premium, totalSeats);
}

export async function addUserToPremium({
  visitorId,
  premiumId,
}: {
  visitorId: string;
  premiumId: string;
}) {
  await prisma.premium.update({
    where: { id: premiumId },
    data: { users: { connect: { id: visitorId } } },
  });
  await syncPremiumSeats(premiumId);
}

export async function removeUserFromPremium({
  visitorId,
  premiumId,
}: {
  visitorId: string;
  premiumId: string;
}) {
  await prisma.premium.update({
    where: { id: premiumId },
    data: { users: { disconnect: { id: visitorId } } },
  });
  await syncPremiumSeats(premiumId);
}

export async function removeFromPendingInvites({
  email,
  premiumId,
}: {
  email: string;
  premiumId: string;
}) {
  const premium = await prisma.premium.findUnique({
    where: { id: premiumId },
    select: { pendingInvites: true },
  });

  if (!premium) return;

  const currentPendingInvites = premium.pendingInvites || [];
  const updatedPendingInvites = currentPendingInvites.filter(
    (pendingEmail) => pendingEmail !== email,
  );

  if (currentPendingInvites.length !== updatedPendingInvites.length) {
    await prisma.premium.update({
      where: { id: premiumId },
      data: { pendingInvites: { set: updatedPendingInvites } },
    });
  }
}

export async function claimPendingPremiumInvite({
  visitorId,
  email,
  premiumId,
}: {
  visitorId: string;
  email: string;
  premiumId: string;
}) {
  await removeFromPendingInvites({ email, premiumId });
  await addUserToPremium({ visitorId, premiumId });
}

export async function updateAccountSeatsForPremium(
  premium: {
    stripeSubscriptionItemId: string | null;
    lemonSqueezySubscriptionItemId?: number | null;
  },
  totalSeats: number,
) {
  if (premium.stripeSubscriptionItemId) {
    await updateStripeSubscriptionItemQuantity({
      subscriptionItemId: premium.stripeSubscriptionItemId,
      quantity: totalSeats,
      logger,
    });
  } else if (premium.lemonSqueezySubscriptionItemId) {
    await updateSubscriptionItemQuantity({
      id: premium.lemonSqueezySubscriptionItemId,
      quantity: totalSeats,
      logger,
    });
  }
}

/**
 * How many billable mailboxes a premium has.
 *
 * Only Google mailboxes count. They are the ones reached through Nylas, and
 * they are the only family that costs money to read.
 *
 * Nylas bills per connected account: a monthly base that covers a number of
 * accounts and a per-account rate on top of it. Those included accounts belong
 * to *our* Nylas plan, not to our users, so they cannot be handed out as an
 * allowance here: every Google mailbox any user connects consumes one of them.
 * Each Google mailbox is therefore billed on its own, and the price is ours to
 * set - see `GOOGLE_MAILBOX_PRICE_CAD`, which the Stripe price has to match.
 */
export function getStripeBillingQuantity({
  users,
}: {
  priceId?: string | null;
  users: {
    emailAccounts: { account: { provider: string } }[];
  }[];
}): number {
  const googleMailboxes = sumBy(
    users,
    (user) =>
      user.emailAccounts.filter(
        (emailAccount) => emailAccount.account.provider === BILLABLE_PROVIDER,
      ).length,
  );

  return Math.max(1, googleMailboxes);
}
