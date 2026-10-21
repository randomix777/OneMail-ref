// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { redirectToSafeUrl } = vi.hoisted(() => ({
  redirectToSafeUrl: vi.fn(),
}));

vi.mock("@/utils/redirect", () => ({ redirectToSafeUrl }));

import { JyiOAuthRedirect } from "./JyiOAuthRedirect";

describe("JyiOAuthRedirect", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sends the user to the provider's authorize page", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://identity.example.com/authorize?state=abc",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<JyiOAuthRedirect callbackURL="/welcome-redirect" />);

    await waitFor(() => {
      expect(redirectToSafeUrl).toHaveBeenCalledWith(
        "https://identity.example.com/authorize?state=abc",
        { allowExternal: true },
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/sign-in/oauth2",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not bypass JYI sign-in when the provider cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ message: "Could not reach the sign-in page" }),
      }),
    );

    render(<JyiOAuthRedirect callbackURL="/welcome-redirect" />);

    await waitFor(() => {
      expect(screen.getByText("Could not reach the sign-in page")).toBeTruthy();
    });
    expect(screen.queryByRole("link")).toBeNull();
  });
});
