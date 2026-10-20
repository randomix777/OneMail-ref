import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { hasPaidMailboxSubscription } from "./paid-mailbox";

vi.mock("@/utils/prisma");

vi.mock("@/utils/premium", () => ({
  isPremiumRecord: vi.fn((premium) =>
    Boolean(premium?.stripeSubscriptionStatus),
  ),
  premiumEntitlementSelect: {},
}));

describe("hasPaidMailboxSubscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is true when the user has a subscription on file", async () => {
    prisma.user.findUnique.mockResolvedValue({
      premium: { stripeSubscriptionStatus: "active" },
      // biome-ignore lint/suspicious/noExplicitAny: a partial prisma row is enough
    } as any);

    await expect(
      hasPaidMailboxSubscription({ userId: "user-1" }),
    ).resolves.toBe(true);
  });

  it("is false when the user has no subscription", async () => {
    prisma.user.findUnique.mockResolvedValue({
      premium: { stripeSubscriptionStatus: null },
      // biome-ignore lint/suspicious/noExplicitAny: a partial prisma row is enough
    } as any);

    await expect(
      hasPaidMailboxSubscription({ userId: "user-1" }),
    ).resolves.toBe(false);
  });

  it("is false when the user has no premium record at all", async () => {
    prisma.user.findUnique.mockResolvedValue({
      premium: null,
      // biome-ignore lint/suspicious/noExplicitAny: a partial prisma row is enough
    } as any);

    await expect(
      hasPaidMailboxSubscription({ userId: "user-1" }),
    ).resolves.toBe(false);
  });
});
