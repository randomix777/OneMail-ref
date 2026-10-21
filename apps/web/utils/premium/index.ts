import type { PremiumTier } from "@/generated/prisma/enums";
import type { Premium } from "@/generated/prisma/client";
import { env } from "@/env";

const APPLE_ACTIVE_STATUSES = new Set([
  "ACTIVE",
  "BILLING_GRACE_PERIOD",
  "BILLING_RETRY",
]);

export const premiumEntitlementSelect = {
  appleExpiresAt: true,
  appleRevokedAt: true,
  appleSubscriptionStatus: true,
  adminGrantExpiresAt: true,
  adminGrantTier: true,
  lemonSqueezyRenewsAt: true,
  stripeSubscriptionStatus: true,
  tier: true,
} as const;

function isPremiumStripe(stripeSubscriptionStatus: string | null): boolean {
  if (!stripeSubscriptionStatus) return false;
  const activeStatuses = ["active", "trialing"];
  return activeStatuses.includes(stripeSubscriptionStatus);
}

function isActiveStripe(stripeSubscriptionStatus: string | null): boolean {
  return stripeSubscriptionStatus === "active";
}

function isPremiumLemonSqueezy(
  lemonSqueezyRenewsAt: Date | string | null,
): boolean {
  if (!lemonSqueezyRenewsAt) return false;
  return new Date(lemonSqueezyRenewsAt) > new Date();
}

function isPremiumAdminGrant(
  adminGrantExpiresAt: Date | string | null,
): boolean {
  if (!adminGrantExpiresAt) return false;
  return new Date(adminGrantExpiresAt) > new Date();
}

export function hasActiveAppleSubscription(
  appleExpiresAt: Date | string | null,
  appleRevokedAt: Date | string | null,
  appleSubscriptionStatus?: string | null,
): boolean {
  if (appleRevokedAt) return false;

  if (
    appleSubscriptionStatus &&
    APPLE_ACTIVE_STATUSES.has(appleSubscriptionStatus)
  ) {
    return true;
  }

  if (!appleExpiresAt) return false;

  return new Date(appleExpiresAt) > new Date();
}

export const isPremium = (
  lemonSqueezyRenewsAt: Date | string | null,
  stripeSubscriptionStatus: string | null,
  appleExpiresAt?: Date | string | null,
  appleRevokedAt?: Date | string | null,
  appleSubscriptionStatus?: string | null,
  adminGrantExpiresAt?: Date | string | null,
): boolean => {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) return true;

  return (
    isPremiumStripe(stripeSubscriptionStatus) ||
    isPremiumLemonSqueezy(lemonSqueezyRenewsAt) ||
    isPremiumAdminGrant(adminGrantExpiresAt || null) ||
    hasActiveAppleSubscription(
      appleExpiresAt || null,
      appleRevokedAt || null,
      appleSubscriptionStatus,
    )
  );
};

type PremiumStatusRecord = {
  appleExpiresAt?: Date | string | null;
  appleRevokedAt?: Date | string | null;
  appleSubscriptionStatus?: string | null;
  adminGrantExpiresAt?: Date | string | null;
  adminGrantTier?: PremiumTier | null;
  lemonSqueezyRenewsAt?: Date | string | null;
  stripeSubscriptionStatus?: string | null;
  tier?: PremiumTier | null;
};

export const isPremiumRecord = (
  premium?: PremiumStatusRecord | null,
): boolean => {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) return true;
  if (!premium) return false;

  return (
    hasProcessorPremiumEntitlement(premium) ||
    hasAdminGrantPremiumEntitlement(premium)
  );
};

export const isActivePremium = (
  premium?: PremiumStatusRecord | null,
): boolean => {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) return true;

  if (!premium) return false;

  return (
    hasActiveProcessorPremiumEntitlement(premium) ||
    hasAdminGrantPremiumEntitlement(premium)
  );
};

export const getUserTier = (
  premium?: Pick<
    Premium,
    | "appleExpiresAt"
    | "appleRevokedAt"
    | "appleSubscriptionStatus"
    | "adminGrantExpiresAt"
    | "adminGrantTier"
    | "tier"
    | "lemonSqueezyRenewsAt"
    | "stripeSubscriptionStatus"
  > | null,
) => {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return "PROFESSIONAL_ANNUALLY" as const;
  }

  if (!premium) return null;

  const hasActiveProcessorEntitlement =
    isPremiumStripe(premium.stripeSubscriptionStatus ?? null) ||
    isPremiumLemonSqueezy(premium.lemonSqueezyRenewsAt ?? null) ||
    hasActiveAppleSubscription(
      premium.appleExpiresAt ?? null,
      premium.appleRevokedAt ?? null,
      premium.appleSubscriptionStatus,
    );
  const processorTier = hasActiveProcessorEntitlement
    ? premium.tier || null
    : null;
  const adminGrantTier = isPremiumAdminGrant(
    premium.adminGrantExpiresAt ?? null,
  )
    ? premium.adminGrantTier || null
    : null;

  if (!processorTier) return adminGrantTier;
  if (!adminGrantTier) return processorTier;

  return isOnHigherTier(adminGrantTier, processorTier)
    ? adminGrantTier
    : processorTier;
};

export const isAdminForPremium = (
  premiumAdmins: { id: string }[],
  userId: string,
) => {
  // if no admins are set, then we skip the check
  if (!premiumAdmins.length) return true;
  return premiumAdmins.some((admin) => admin.id === userId);
};

const tierRanking = {
  BASIC_MONTHLY: 1,
  BASIC_ANNUALLY: 2,
  PRO_MONTHLY: 3,
  PRO_ANNUALLY: 4,
  STARTER_MONTHLY: 5,
  STARTER_ANNUALLY: 6,
  PLUS_MONTHLY: 7,
  PLUS_ANNUALLY: 8,
  PROFESSIONAL_MONTHLY: 9,
  PROFESSIONAL_ANNUALLY: 10,
  COPILOT_MONTHLY: 11,
  LIFETIME: 12,
};

function getTiersAtOrAbove(minimumTier: PremiumTier): PremiumTier[] {
  const minimumRanking = tierRanking[minimumTier];

  return Object.entries(tierRanking)
    .filter(([, ranking]) => ranking >= minimumRanking)
    .map(([tier]) => tier as PremiumTier);
}

// Legacy rows hold a bare 1-12 month, which never matches a period, so they
// get one reset on next use.
export const getUnsubscribePeriod = (now = new Date()): number =>
  now.getFullYear() * 100 + now.getMonth() + 1;

export const getRemainingUnsubscribeCredits = ({
  unsubscribeCredits,
  unsubscribeMonth,
  now = new Date(),
}: {
  unsubscribeCredits?: number | null;
  unsubscribeMonth?: number | null;
  now?: Date;
}): number =>
  unsubscribeMonth === getUnsubscribePeriod(now)
    ? (unsubscribeCredits ?? 0)
    : env.NEXT_PUBLIC_FREE_UNSUBSCRIBE_CREDITS;

/**
 * Whether an account may bulk unsubscribe.
 *
 * Unsubscribing is a provider-side action we pay nothing for, so it is open to
 * every account. The credits that used to limit it are still counted, but they
 * no longer stop anyone.
 */
export const hasUnsubscribeAccess = (): boolean => true;

/**
 * Whether an account may use the assistant.
 *
 * The assistant is metered by the token rather than by the seat, so it is open
 * to every account and the tier is not consulted. What actually stops the
 * assistant is a deployment with no model to reach, and that is reported by
 * the model resolution rather than as an entitlement.
 */
export const hasAiAccess = (): boolean => true;

/**
 * Whether an account may use a feature that used to sit behind a plan.
 *
 * There is no plan any more. The client is free, the assistant is metered by
 * the token through the gateway, and the only thing that is billed is Google
 * mail. So nothing is held back here: what is left of the tier machinery is
 * there for the billing, not for the features.
 */
export const hasTierAccess = (): boolean => true;

export function isOnHigherTier(
  tier1?: PremiumTier | null,
  tier2?: PremiumTier | null,
) {
  const tier1Rank = tier1 ? tierRanking[tier1] : 0;
  const tier2Rank = tier2 ? tierRanking[tier2] : 0;

  return tier1Rank > tier2Rank;
}

export function getPremiumUserFilter({
  minimumTier,
}: {
  minimumTier?: PremiumTier;
} = {}) {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) return {};

  const minimumTiers = minimumTier ? getTiersAtOrAbove(minimumTier) : undefined;
  const tierFilter = minimumTiers
    ? [{ tier: { in: minimumTiers } }]
    : [{ tier: { not: null } }];
  const adminGrantTierFilter = minimumTiers
    ? [{ adminGrantTier: { in: minimumTiers } }]
    : [{ adminGrantTier: { not: null } }];
  const now = new Date();

  return {
    user: {
      premium: {
        OR: [
          {
            AND: [
              { appleExpiresAt: { gt: now } },
              { appleRevokedAt: null },
              ...tierFilter,
            ],
          },
          {
            AND: [{ lemonSqueezyRenewsAt: { gt: now } }, ...tierFilter],
          },
          {
            AND: [
              { stripeSubscriptionStatus: { in: ["active", "trialing"] } },
              ...tierFilter,
            ],
          },
          {
            AND: [
              { adminGrantExpiresAt: { gt: now } },
              ...adminGrantTierFilter,
            ],
          },
        ],
      },
    },
  };
}

function hasProcessorPremiumEntitlement(premium: PremiumStatusRecord) {
  if (!premium.tier) return false;

  return (
    isPremiumStripe(premium.stripeSubscriptionStatus ?? null) ||
    isPremiumLemonSqueezy(premium.lemonSqueezyRenewsAt ?? null) ||
    hasActiveAppleSubscription(
      premium.appleExpiresAt ?? null,
      premium.appleRevokedAt ?? null,
      premium.appleSubscriptionStatus,
    )
  );
}

function hasActiveProcessorPremiumEntitlement(premium: PremiumStatusRecord) {
  if (!premium.tier) return false;

  return (
    isActiveStripe(premium.stripeSubscriptionStatus ?? null) ||
    isPremiumLemonSqueezy(premium.lemonSqueezyRenewsAt ?? null) ||
    hasActiveAppleSubscription(
      premium.appleExpiresAt ?? null,
      premium.appleRevokedAt ?? null,
      premium.appleSubscriptionStatus,
    )
  );
}

function hasAdminGrantPremiumEntitlement(premium: PremiumStatusRecord) {
  if (!premium.adminGrantTier) return false;

  return isPremiumAdminGrant(premium.adminGrantExpiresAt ?? null);
}
