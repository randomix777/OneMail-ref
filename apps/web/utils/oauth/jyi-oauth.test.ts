import { describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: {
    JYI_OAUTH_DISCOVERY_URL: "",
    JYI_OAUTH_CLIENT_ID: "",
  },
}));

vi.mock("@/env", () => ({ env: envMock }));

import { isJyiOauthEnabled } from "./jyi-oauth";

describe("isJyiOauthEnabled", () => {
  it("is off without a provider", () => {
    envMock.JYI_OAUTH_DISCOVERY_URL = "";
    envMock.JYI_OAUTH_CLIENT_ID = "";

    expect(isJyiOauthEnabled()).toBe(false);
  });

  it("is on once the provider and the client are configured", () => {
    envMock.JYI_OAUTH_DISCOVERY_URL =
      "https://auth.jyisolutions.com/.well-known/openid-configuration";
    envMock.JYI_OAUTH_CLIENT_ID = "client-id";

    expect(isJyiOauthEnabled()).toBe(true);
  });

  it("is off when only half of it is configured", () => {
    envMock.JYI_OAUTH_DISCOVERY_URL =
      "https://auth.jyisolutions.com/.well-known/openid-configuration";
    envMock.JYI_OAUTH_CLIENT_ID = "";

    expect(isJyiOauthEnabled()).toBe(false);
  });
});
