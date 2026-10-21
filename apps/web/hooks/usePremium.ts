"use client";

import { env } from "@/env";
import { useUser } from "@/hooks/useUser";
import {
  getUserTier,
  hasUnsubscribeAccess,
  isPremiumRecord,
} from "@/utils/premium";

export function usePremium() {
  const swrResponse = useUser();
  const { data } = swrResponse;

  const premium = data?.premium;
  const hasAiApiKey = data?.hasAiApiKey;
  const canManageBilling = data?.canManageBilling ?? false;

  const unsubscribeCreditsRemaining = data?.unsubscribeCreditsRemaining;

  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return {
      ...swrResponse,
      premium,
      canManageBilling,
      isPremium: true,
      hasUnsubscribeAccess: true,
      unsubscribeCreditsRemaining,
      hasAiAccess: true,
      isProPlanWithoutApiKey: false,
      tier: "PROFESSIONAL_ANNUALLY" as const,
    };
  }

  const isUserPremium = isPremiumRecord(premium);
  const tier = getUserTier(premium);

  const isProPlanWithoutApiKey =
    (tier === "PRO_MONTHLY" || tier === "PRO_ANNUALLY") && !hasAiApiKey;

  return {
    ...swrResponse,
    premium,
    canManageBilling,
    isPremium: isUserPremium,
    hasUnsubscribeAccess: hasUnsubscribeAccess(),
    unsubscribeCreditsRemaining,
    // The assistant is metered by the token rather than by the seat, so it
    // is open to every account.
    hasAiAccess: true,
    isProPlanWithoutApiKey,
    tier,
  };
}
