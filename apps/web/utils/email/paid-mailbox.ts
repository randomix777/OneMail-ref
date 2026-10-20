import prisma from "@/utils/prisma";
import { isPremiumRecord, premiumEntitlementSelect } from "@/utils/premium";

/**
 * Whether a user may connect a mailbox that costs money to read.
 *
 * Google mail reaches us through a broker we pay per account for, so a
 * subscription is what covers it. Every other family connects straight to its
 * provider and costs nothing, which is why this says nothing about them.
 */
export async function hasPaidMailboxSubscription({
  userId,
}: {
  userId: string;
}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { premium: { select: premiumEntitlementSelect } },
  });

  return isPremiumRecord(user?.premium ?? null);
}
