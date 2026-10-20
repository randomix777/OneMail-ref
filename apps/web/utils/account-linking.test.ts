import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccountLinkingUrl } from "./account-linking";

describe("getAccountLinkingUrl", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the OAuth URL on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://api.us.nylas.com/v3/connect/auth",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAccountLinkingUrl("google")).resolves.toBe(
      "https://api.us.nylas.com/v3/connect/auth",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/nylas/linking/auth-url", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
  });

  it("uses the family's own linking route, not a fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://login.microsoftonline.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getAccountLinkingUrl("microsoft", {
      reconnectEmailAccountId: "email-account-id",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/outlook/linking/auth-url?emailAccountId=email-account-id",
      expect.anything(),
    );
  });

  it("surfaces a known error from the linking route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error:
            "Google mail requires Nylas to be configured on this instance.",
          isKnownError: true,
        }),
      }),
    );

    await expect(getAccountLinkingUrl("google")).rejects.toThrow(
      "Google mail requires Nylas to be configured on this instance.",
    );
  });

  it("returns the redirect URL when the server asks the client to log out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ redirectTo: "/logout" }),
      }),
    );

    await expect(getAccountLinkingUrl("google")).resolves.toBe("/logout");
  });

  it("returns the redirect URL when the server sends the user somewhere else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: "Google mail is billed per mailbox.",
          isKnownError: true,
          redirectTo: "/accounts?error=google_mail_requires_subscription",
        }),
      }),
    );

    await expect(getAccountLinkingUrl("google")).resolves.toBe(
      "/accounts?error=google_mail_requires_subscription",
    );
  });
});
