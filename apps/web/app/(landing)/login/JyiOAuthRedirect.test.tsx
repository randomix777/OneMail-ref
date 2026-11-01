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

  it("starts the account-centre Firebase handoff", async () => {
    render(<JyiOAuthRedirect callbackURL="/welcome-redirect" />);

    await waitFor(() => {
      expect(redirectToSafeUrl).toHaveBeenCalledWith(
        "/api/auth/firebase/start?callbackURL=%2Fwelcome-redirect",
      );
    });
  });

  it("does not redirect when the handoff is not configured", () => {
    render(
      <JyiOAuthRedirect callbackURL="/welcome-redirect" configured={false} />,
    );

    expect(
      screen.getByText("Sign-in is not configured on this instance."),
    ).toBeTruthy();
    expect(redirectToSafeUrl).not.toHaveBeenCalled();
  });
});
