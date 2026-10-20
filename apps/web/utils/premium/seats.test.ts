import { describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BASIC_MONTHLY_VARIANT_ID: 1,
    NEXT_PUBLIC_BASIC_ANNUALLY_VARIANT_ID: 2,
    NEXT_PUBLIC_PRO_MONTHLY_VARIANT_ID: 3,
    NEXT_PUBLIC_PRO_ANNUALLY_VARIANT_ID: 4,
    NEXT_PUBLIC_BUSINESS_MONTHLY_VARIANT_ID: 5,
    NEXT_PUBLIC_BUSINESS_ANNUALLY_VARIANT_ID: 6,
    NEXT_PUBLIC_COPILOT_MONTHLY_VARIANT_ID: 7,
    NEXT_PUBLIC_STRIPE_BUSINESS_MONTHLY_PRICE_ID:
      "price_current_starter_monthly",
    NEXT_PUBLIC_STRIPE_BUSINESS_ANNUALLY_PRICE_ID:
      "price_current_starter_annual",
    NEXT_PUBLIC_STRIPE_PLUS_MONTHLY_PRICE_ID: "price_current_plus_monthly",
    NEXT_PUBLIC_STRIPE_PLUS_ANNUALLY_PRICE_ID: "price_current_plus_annual",
    NEXT_PUBLIC_STRIPE_BUSINESS_PLUS_MONTHLY_PRICE_ID:
      "price_current_professional_monthly",
    NEXT_PUBLIC_STRIPE_BUSINESS_PLUS_ANNUALLY_PRICE_ID:
      "price_current_professional_annual",
    NEXT_PUBLIC_APPLE_IAP_STARTER_MONTHLY_PRODUCT_ID: "starter.monthly",
    NEXT_PUBLIC_APPLE_IAP_STARTER_ANNUALLY_PRODUCT_ID: "starter.annual",
  },
}));

vi.mock("@/utils/prisma", () => ({
  default: {},
}));

vi.mock("@/ee/billing/lemon/index", () => ({
  updateSubscriptionItemQuantity: vi.fn(),
}));

vi.mock("@/ee/billing/stripe/index", () => ({
  updateStripeSubscriptionItemQuantity: vi.fn(),
}));

import { getStripeBillingQuantity } from "./seats";

/** `count` mailboxes on Google, which are the billable ones. */
function accounts(count: number) {
  return Array.from({ length: count }, () => ({
    account: { provider: "google" },
  }));
}

describe("getStripeBillingQuantity", () => {
  it("bills every Google mailbox", () => {
    expect(
      getStripeBillingQuantity({
        users: [{ emailAccounts: accounts(2) }],
      }),
    ).toBe(2);
  });

  it("only bills mailboxes reached through the paid provider", () => {
    // A mailbox on a family that connects directly costs us nothing, so it is
    // not billed.
    expect(
      getStripeBillingQuantity({
        users: [
          {
            emailAccounts: [
              { account: { provider: "microsoft" } },
              { account: { provider: "yahoo" } },
              { account: { provider: "imap" } },
            ],
          },
        ],
      }),
    ).toBe(1);
  });

  it("counts shared users separately", () => {
    expect(
      getStripeBillingQuantity({
        users: [{ emailAccounts: accounts(2) }, { emailAccounts: accounts(1) }],
      }),
    ).toBe(3);
  });

  it("keeps a subscription at one unit when nothing is billable", () => {
    // A subscription item cannot have a quantity of zero, so a plan always
    // bills at least one.
    expect(
      getStripeBillingQuantity({
        users: [{ emailAccounts: [] }],
      }),
    ).toBe(1);
  });
});
