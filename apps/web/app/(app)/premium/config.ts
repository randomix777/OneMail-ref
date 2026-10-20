import { env } from "@/env";
import type { PremiumTier } from "@/generated/prisma/enums";

type Feature = { text: string; tooltip?: string };

export type Tier = {
  name: string;
  tiers: { monthly: PremiumTier; annually: PremiumTier };
  price: { monthly: number; annually: number };
  discount: { monthly: number; annually: number };
  quantity?: number;
  /** What one unit of the price covers, shown next to the amount. */
  unit?: string;
  description: string;
  features: Feature[];
  cta: string;
  ctaLink?: string;
  mostPopular?: boolean;
};

const variantIdToTier: Record<number, PremiumTier> = {
  [env.NEXT_PUBLIC_BASIC_MONTHLY_VARIANT_ID]: "BASIC_MONTHLY",
  [env.NEXT_PUBLIC_BASIC_ANNUALLY_VARIANT_ID]: "BASIC_ANNUALLY",
  [env.NEXT_PUBLIC_PRO_MONTHLY_VARIANT_ID]: "PRO_MONTHLY",
  [env.NEXT_PUBLIC_PRO_ANNUALLY_VARIANT_ID]: "PRO_ANNUALLY",
  [env.NEXT_PUBLIC_BUSINESS_MONTHLY_VARIANT_ID]: "STARTER_MONTHLY",
  [env.NEXT_PUBLIC_BUSINESS_ANNUALLY_VARIANT_ID]: "STARTER_ANNUALLY",
  [env.NEXT_PUBLIC_COPILOT_MONTHLY_VARIANT_ID]: "COPILOT_MONTHLY",
};

export const BRIEF_MY_MEETING_PRICE_ID_MONTHLY =
  "price_1SjoaXKGf8mwZWHnOdyaf2IN";
export const BRIEF_MY_MEETING_PRICE_ID_ANNUALLY =
  "price_1SjoawKGf8mwZWHnfAeShYhb";

const STRIPE_PRICE_ID_CONFIG: Record<
  PremiumTier,
  {
    // active price id
    priceId?: string;
    // Allow handling of old price ids
    oldPriceIds?: string[];
  }
> = {
  BASIC_MONTHLY: { priceId: "price_1RfeDLKGf8mwZWHn6UW8wJcY" },
  BASIC_ANNUALLY: { priceId: "price_1RfeDLKGf8mwZWHn5kfC8gcM" },
  PRO_MONTHLY: {},
  PRO_ANNUALLY: {},
  STARTER_MONTHLY: {
    priceId: env.NEXT_PUBLIC_STRIPE_BUSINESS_MONTHLY_PRICE_ID,
    oldPriceIds: [
      "price_1T9FhCKGf8mwZWHn1olNzv6X",
      "price_1S5u73KGf8mwZWHn8VYFdALA",
      "price_1RMSnIKGf8mwZWHnlHP0212n",
      "price_1RfoILKGf8mwZWHnDiUMj6no",
      "price_1RfeAFKGf8mwZWHnnnPzFEky",
      "price_1RfSoHKGf8mwZWHnxTsSDTqW",
      "price_1Rg0QfKGf8mwZWHnDsiocBVD",
      "price_1Rg0LEKGf8mwZWHndYXYg7ie",
      "price_1Rg03pKGf8mwZWHnWMNeQzLc",
      BRIEF_MY_MEETING_PRICE_ID_MONTHLY,
    ],
  },
  STARTER_ANNUALLY: {
    priceId: env.NEXT_PUBLIC_STRIPE_BUSINESS_ANNUALLY_PRICE_ID,
    oldPriceIds: [
      "price_1S5u6uKGf8mwZWHnEvPWuQzG",
      "price_1S1QGGKGf8mwZWHnYpUcqNua",
      "price_1RMSnIKGf8mwZWHnymtuW2s0",
      "price_1RfSoxKGf8mwZWHngHcug4YM",
      // brief my meeting
      BRIEF_MY_MEETING_PRICE_ID_ANNUALLY,
    ],
  },
  PLUS_MONTHLY: {
    priceId: env.NEXT_PUBLIC_STRIPE_PLUS_MONTHLY_PRICE_ID,
  },
  PLUS_ANNUALLY: {
    priceId: env.NEXT_PUBLIC_STRIPE_PLUS_ANNUALLY_PRICE_ID,
  },
  PROFESSIONAL_MONTHLY: {
    priceId: env.NEXT_PUBLIC_STRIPE_BUSINESS_PLUS_MONTHLY_PRICE_ID,
    oldPriceIds: [
      "price_1S5u6NKGf8mwZWHnZCfy4D5n",
      "price_1RMSoMKGf8mwZWHn5fAKBT19",
    ],
  },
  PROFESSIONAL_ANNUALLY: {
    priceId: env.NEXT_PUBLIC_STRIPE_BUSINESS_PLUS_ANNUALLY_PRICE_ID,
    oldPriceIds: [
      "price_1S5u6XKGf8mwZWHnba8HX1H2",
      "price_1RMSoMKGf8mwZWHnGjf6fRmh",
    ],
  },
  COPILOT_MONTHLY: {},
  LIFETIME: {},
};

const APPLE_PRODUCT_ID_CONFIG: Partial<Record<PremiumTier, string>> = {
  STARTER_MONTHLY: env.NEXT_PUBLIC_APPLE_IAP_STARTER_MONTHLY_PRODUCT_ID,
  STARTER_ANNUALLY: env.NEXT_PUBLIC_APPLE_IAP_STARTER_ANNUALLY_PRODUCT_ID,
};

/**
 * App Store products sold by the native iOS app. Both grant the `pro`
 * Superwall entitlement, which is the Starter tier (the same tier Stripe's
 * business prices and Lemon's business variants map to).
 */
const APPLE_STARTER_PRODUCT_IDS: Record<string, PremiumTier> = {
  "com.getinboxzero.starter.monthly.v2": "STARTER_MONTHLY",
  "com.getinboxzero.starter.annual.v2": "STARTER_ANNUALLY",
};

export function getStripeSubscriptionTier({
  priceId,
}: {
  priceId: string;
}): PremiumTier | null {
  const entries = Object.entries(STRIPE_PRICE_ID_CONFIG);

  for (const [tier, config] of entries) {
    if (config.priceId === priceId || config.oldPriceIds?.includes(priceId)) {
      return tier as PremiumTier;
    }
  }
  return null;
}

export function getStripePriceId({
  tier,
}: {
  tier: PremiumTier;
}): string | null {
  return STRIPE_PRICE_ID_CONFIG[tier]?.priceId ?? null;
}

/**
 * What a Google mailbox costs a month, in Canadian dollars.
 *
 * Google mail is reached through Nylas, so it is the one family that costs
 * money to read, and every other family is free. The Stripe price that backs
 * the subscription is set to this amount, so the two have to be kept in step.
 */
export const GOOGLE_MAILBOX_PRICE_CAD = 4.99;

export function getAppleSubscriptionTier({
  productId,
}: {
  productId: string;
}): PremiumTier | null {
  const starterTier = APPLE_STARTER_PRODUCT_IDS[productId];
  if (starterTier) return starterTier;

  for (const [tier, configuredProductId] of Object.entries(
    APPLE_PRODUCT_ID_CONFIG,
  )) {
    if (configuredProductId === productId) {
      return tier as PremiumTier;
    }
  }

  return null;
}

export function hasLegacyStripePriceId({
  tier,
  priceId,
}: {
  tier: PremiumTier | null | undefined;
  priceId: string | null | undefined;
}): boolean {
  if (!priceId) return false;

  const resolvedTier = tier || getStripeSubscriptionTier({ priceId });
  if (!resolvedTier) return false;

  const tierConfig = STRIPE_PRICE_ID_CONFIG[resolvedTier];
  if (!tierConfig) return false;
  // We sometimes reuse a historical price as the active price again.
  if (tierConfig.priceId === priceId) return false;

  return tierConfig.oldPriceIds?.includes(priceId) ?? false;
}

export function shouldShowLegacyStripePricingNotice(
  premium:
    | {
        tier: PremiumTier | null | undefined;
        stripePriceId: string | null | undefined;
        stripeSubscriptionStatus: string | null | undefined;
      }
    | null
    | undefined,
): boolean {
  if (!premium?.stripeSubscriptionStatus) return false;
  if (!["active", "trialing"].includes(premium.stripeSubscriptionStatus)) {
    return false;
  }

  return hasLegacyStripePriceId({
    tier: premium.tier,
    priceId: premium.stripePriceId,
  });
}

export function getPremiumTierName(
  tier: PremiumTier | null | undefined,
): string {
  if (!tier) return "Premium";

  const tierMap: Partial<Record<PremiumTier, string>> = {
    STARTER_MONTHLY: "Starter",
    STARTER_ANNUALLY: "Starter",
    PLUS_MONTHLY: "Plus",
    PLUS_ANNUALLY: "Plus",
    PROFESSIONAL_MONTHLY: "Professional",
    PROFESSIONAL_ANNUALLY: "Professional",
    COPILOT_MONTHLY: "Enterprise",
    BASIC_MONTHLY: "Basic",
    BASIC_ANNUALLY: "Basic",
    PRO_MONTHLY: "Pro",
    PRO_ANNUALLY: "Pro",
    LIFETIME: "Lifetime",
  };

  return tierMap[tier] ?? "Premium";
}

export const starterTierName = "Starter";

/**
 * The one thing that is billed.
 *
 * The client is free, and so is every provider that connects straight to its
 * own server. Google mail is the exception: it reaches us through a broker we
 * pay per account for, so it is billed per mailbox, every month.
 */
const googleMailTier: Tier = {
  name: "Google mail",
  tiers: {
    monthly: "STARTER_MONTHLY",
    annually: "STARTER_MONTHLY",
  },
  price: {
    monthly: GOOGLE_MAILBOX_PRICE_CAD,
    annually: GOOGLE_MAILBOX_PRICE_CAD,
  },
  discount: { monthly: 0, annually: 0 },
  unit: "CAD per mailbox",
  description:
    "Google mail reaches us through Nylas, because that is the only way to hold the scopes Google requires. Every Google mailbox you connect is billed every month. Every other provider is free.",
  features: [
    {
      text: "The client is free, with every feature in it",
    },
    {
      text: "Outlook, Yahoo, Fastmail, iCloud, Zoho and any IMAP server connect for free",
    },
    {
      text: "The assistant is billed per token, not per seat",
    },
    {
      text: "Another Google mailbox is billed the same day, prorated",
    },
    {
      text: "Cancel any time",
    },
  ],
  cta: "Try free for 7 days",
  mostPopular: false,
};

const enterpriseTier: Tier = {
  name: "Enterprise",
  tiers: {
    monthly: "COPILOT_MONTHLY",
    annually: "COPILOT_MONTHLY",
  },
  price: { monthly: 0, annually: 0 },
  discount: { monthly: 0, annually: 0 },
  description:
    "For organizations with enterprise-grade security and compliance requirements.",
  features: [
    {
      text: "Everything in Team, plus:",
    },
    {
      text: "SSO login",
    },
    {
      text: "SCIM user provisioning",
    },
    {
      text: "On-premise deployment (optional)",
    },
    {
      text: "Advanced security & SLA",
    },
    {
      text: "Dedicated account manager & training",
    },
  ],
  cta: "Speak to sales",
  ctaLink: "https://www.jyisolutions.com/sales",
  mostPopular: false,
};

export function getLemonSubscriptionTier({
  variantId,
}: {
  variantId: number;
}): PremiumTier {
  const tier = variantIdToTier[variantId];
  if (!tier) throw new Error(`Unknown variant id: ${variantId}`);
  return tier;
}

export const tiers: Tier[] = [googleMailTier];
export { enterpriseTier };
