import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNylasAuthUrl,
  exchangeNylasCodeForGrantId,
  getNylasGrant,
  getNylasLinkingRedirectUri,
} from "@/utils/nylas/auth";

const { nylasEnv } = vi.hoisted(() => ({
  nylasEnv: {
    NYLAS_API_KEY: "nylas-api-key" as string | undefined,
    NYLAS_CLIENT_ID: "nylas-client-id" as string | undefined,
    NYLAS_API_URI: "https://api.us.nylas.com",
    NEXT_PUBLIC_BASE_URL: "https://app.example.com",
  },
}));

vi.mock("@/env", () => ({ env: nylasEnv }));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildNylasAuthUrl", () => {
  beforeEach(() => {
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    nylasEnv.NYLAS_CLIENT_ID = "nylas-client-id";
  });

  it("asks Nylas for a Google authorization code back at our callback", () => {
    const url = new URL(buildNylasAuthUrl({ state: "signed-state" }));

    expect(url.origin + url.pathname).toBe(
      "https://api.us.nylas.com/v3/connect/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("nylas-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/nylas/linking/callback",
    );
  });

  it("does not ask Nylas for a refresh token we would never use", () => {
    const url = new URL(buildNylasAuthUrl({ state: "state" }));

    expect(url.searchParams.get("access_type")).toBe("online");
  });

  it("prefills the mailbox a reconnect is targeting", () => {
    const url = new URL(
      buildNylasAuthUrl({ state: "state", loginHint: "ada@example.com" }),
    );

    expect(url.searchParams.get("login_hint")).toBe("ada@example.com");
  });

  it("omits the hint when adding an account rather than reconnecting", () => {
    const url = new URL(buildNylasAuthUrl({ state: "state" }));

    expect(url.searchParams.has("login_hint")).toBe(false);
  });

  it("refuses to build a URL without a client id", () => {
    nylasEnv.NYLAS_CLIENT_ID = undefined;

    expect(() => buildNylasAuthUrl({ state: "state" })).toThrow(
      "NYLAS_CLIENT_ID is not configured",
    );
  });
});

describe("exchangeNylasCodeForGrantId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    nylasEnv.NYLAS_CLIENT_ID = "nylas-client-id";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("trades the code for a grant id using the API key as the client secret", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ grant_id: "grant-1" }));

    await expect(exchangeNylasCodeForGrantId("code-1")).resolves.toBe(
      "grant-1",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://api.us.nylas.com/v3/connect/token");
    expect(JSON.parse(init.body)).toEqual({
      client_id: "nylas-client-id",
      client_secret: "nylas-api-key",
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://app.example.com/api/nylas/linking/callback",
    });
  });

  it("fails loudly when Nylas returns no grant", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: "token" }));

    await expect(exchangeNylasCodeForGrantId("code-1")).rejects.toThrow(
      "Nylas did not return a grant for this account.",
    );
  });
});

describe("getNylasGrant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("reads the mailbox identity off the grant", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          id: "grant-1",
          email: "ada@example.com",
          provider: "google",
        },
      }),
    );

    await expect(getNylasGrant("grant-1")).resolves.toEqual({
      id: "grant-1",
      email: "ada@example.com",
      provider: "google",
    });
  });

  it("rejects a grant with no mailbox behind it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: "grant-1" } }));

    await expect(getNylasGrant("grant-1")).rejects.toThrow(
      "Nylas grant is missing its mailbox identity.",
    );
  });
});

describe("getNylasLinkingRedirectUri", () => {
  it("points at the Nylas linking callback", () => {
    expect(getNylasLinkingRedirectUri()).toBe(
      "https://app.example.com/api/nylas/linking/callback",
    );
  });
});
