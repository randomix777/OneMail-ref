import { describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: {
    JYI_OAUTH_DISCOVERY_URL: "",
    JYI_OAUTH_CLIENT_ID: "",
    JYI_OAUTH_CLIENT_SECRET: "",
  },
}));

vi.mock("@/env", () => ({ env: envMock }));

import { isJyiOauthEnabled } from "./jyi-oauth";

describe("isJyiOauthEnabled", () => {
  it("is off without a provider", () => {
    envMock.JYI_OAUTH_DISCOVERY_URL = "";
    envMock.JYI_OAUTH_CLIENT_ID = "";
    envMock.JYI_OAUTH_CLIENT_SECRET = "";

    expect(isJyiOauthEnabled()).toBe(false);
  });

  it("is on once the provider and the client are configured", () => {
    envMock.JYI_OAUTH_DISCOVERY_URL =
      "https://idp.example.com/.well-known/openid-configuration";
    envMock.JYI_OAUTH_CLIENT_ID = "client-id";
    envMock.JYI_OAUTH_CLIENT_SECRET = "client-secret";

    expect(isJyiOauthEnabled()).toBe(true);
  });

  it("is off when any required provider credential is missing", () => {
    envMock.JYI_OAUTH_DISCOVERY_URL =
      "https://idp.example.com/.well-known/openid-configuration";
    envMock.JYI_OAUTH_CLIENT_ID = "client-id";
    envMock.JYI_OAUTH_CLIENT_SECRET = "";

    expect(isJyiOauthEnabled()).toBe(false);

    envMock.JYI_OAUTH_CLIENT_SECRET = "client-secret";
    envMock.JYI_OAUTH_CLIENT_ID = "";

    expect(isJyiOauthEnabled()).toBe(false);
  });
});
