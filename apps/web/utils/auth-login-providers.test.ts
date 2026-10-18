import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_SCOPES } from "@/utils/gmail/scopes";

vi.mock("better-auth", () => ({
  betterAuth: vi.fn((options: unknown) => ({
    api: {
      getSession: vi.fn(),
    },
    options,
  })),
}));

vi.mock("@/utils/prisma");
vi.mock("@googleapis/people", () => ({
  people: vi.fn(),
}));
vi.mock("@googleapis/gmail", () => ({
  auth: {
    OAuth2: vi.fn(),
  },
}));
vi.mock("@/utils/encryption", () => ({
  encryptToken: vi.fn((token) => token),
}));

describe("betterAuthConfig login providers", () => {
  // Each case re-imports the whole auth module to pick up a different provider
  // set, which costs more than the default 5s budget on a loaded machine.
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@/utils/oauth/login-providers");
    vi.doUnmock("@/utils/nylas/client");
  });

  it("does not register social providers when only SSO login is enabled", async () => {
    const betterAuthConfig = await loadBetterAuthConfig(["sso"]);

    expect(betterAuthConfig.options.socialProviders).toEqual({});
  }, 30_000);

  it("registers only enabled social providers", async () => {
    const betterAuthConfig = await loadBetterAuthConfig(["apple"]);

    expect(Object.keys(betterAuthConfig.options.socialProviders)).toEqual([
      "apple",
    ]);
  }, 30_000);

  it("stops asking for Gmail scopes once Nylas carries Google mail", async () => {
    // CASA attaches to the client that requests the restricted scope, so this
    // has to stay true or the whole Nylas design silently regresses: our own
    // client would be asking Google for mail access again.
    const betterAuthConfig = await loadBetterAuthConfig(["google"], {
      nylasConfigured: true,
    });

    const { scope } = betterAuthConfig.options.socialProviders.google;

    expect(scope).toEqual([...IDENTITY_SCOPES]);
    expect(scope.filter((value: string) => value.includes("gmail."))).toEqual(
      [],
    );
  }, 30_000);

  it("keeps Gmail scopes while our own client is still the mail transport", async () => {
    const betterAuthConfig = await loadBetterAuthConfig(["google"], {
      nylasConfigured: false,
    });

    const { scope } = betterAuthConfig.options.socialProviders.google;

    expect(scope).toContain("https://www.googleapis.com/auth/gmail.modify");
  }, 30_000);
});

async function loadBetterAuthConfig(
  enabledProviders: string[],
  { nylasConfigured }: { nylasConfigured: boolean } = {
    nylasConfigured: false,
  },
) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-secret");
  vi.doMock("@/utils/oauth/login-providers", () => ({
    getEnabledLoginProviders: () => new Set(enabledProviders),
  }));
  vi.doMock("@/utils/nylas/client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/utils/nylas/client")>()),
    hasNylasConfig: () => nylasConfigured,
  }));

  const { betterAuthConfig } = await import("@/utils/auth");

  return betterAuthConfig as any;
}
