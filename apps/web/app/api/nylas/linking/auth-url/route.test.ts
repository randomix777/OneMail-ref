import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthState,
  mockBuildNylasAuthUrl,
  mockHasActiveAccountLinkingUser,
  mockHasPaidMailboxSubscription,
} = vi.hoisted(() => ({
  mockAuthState: { userId: "user-1" } as { userId: string; emailOtp?: boolean },
  mockBuildNylasAuthUrl: vi.fn(
    () => "https://api.us.nylas.com/v3/connect/auth",
  ),
  mockHasActiveAccountLinkingUser: vi.fn(),
  mockHasPaidMailboxSubscription: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    AUTH_SECRET: "test-auth-secret",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
    NYLAS_API_KEY: "test-api-key",
    NYLAS_CLIENT_ID: "test-client-id",
    NYLAS_API_URI: "https://api.us.nylas.com",
  },
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithAuthTestMiddleware({ auth: mockAuthState });
});

vi.mock("@/utils/nylas/auth", () => ({
  buildNylasAuthUrl: mockBuildNylasAuthUrl,
  NYLAS_LINKING_STATE_COOKIE_NAME: "nylas_linking_state",
}));

vi.mock("@/utils/nylas/client", () => ({
  hasNylasConfig: () => true,
}));

vi.mock("@/utils/oauth/account-linking", async (importActual) => {
  const actual =
    await importActual<typeof import("@/utils/oauth/account-linking")>();
  return {
    getMailboxLinkingBlockedResponse: actual.getMailboxLinkingBlockedResponse,
    hasActiveAccountLinkingUser: mockHasActiveAccountLinkingUser,
  };
});

vi.mock("@/utils/email/paid-mailbox", () => ({
  hasPaidMailboxSubscription: mockHasPaidMailboxSubscription,
}));

import { GET } from "./route";

describe("nylas linking auth-url route", () => {
  const createRequest = () =>
    new NextRequest("http://localhost:3000/api/nylas/linking/auth-url");

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.emailOtp = undefined;
    mockHasActiveAccountLinkingUser.mockResolvedValue(true);
    mockHasPaidMailboxSubscription.mockResolvedValue(true);
  });

  it("returns an auth URL for a subscriber", async () => {
    const response = await GET(createRequest(), {} as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://api.us.nylas.com/v3/connect/auth",
    });
  });

  it("does not start a paid mailbox connection without a subscription", async () => {
    mockHasPaidMailboxSubscription.mockResolvedValue(false);

    const response = await GET(createRequest(), {} as never);

    expect(response.status).toBe(403);
    expect(mockBuildNylasAuthUrl).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        redirectTo: "/accounts?error=google_mail_requires_subscription",
      }),
    );
  });
});
