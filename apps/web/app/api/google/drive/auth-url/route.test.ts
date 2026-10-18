import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isDriveFilingAvailable = vi.hoisted(() => vi.fn());
const getGoogleDriveOAuth2Url = vi.hoisted(() => vi.fn());

vi.mock("@/utils/drive/availability", () => ({ isDriveFilingAvailable }));
vi.mock("@/utils/drive/client", () => ({ getGoogleDriveOAuth2Url }));

vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (
      _scope: string,
      handler: (request: NextRequest & Record<string, unknown>) => unknown,
    ) =>
    (request: NextRequest) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "email-account-1" },
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }),
      ),
}));

import { GET } from "./route";

describe("GET /api/google/drive/auth-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGoogleDriveOAuth2Url.mockReturnValue("https://accounts.google.com/o");
  });

  it("refuses a mailbox whose mail is reached through Nylas", async () => {
    isDriveFilingAvailable.mockResolvedValue(false);

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/google/drive/auth-url?access=full",
      ),
    );

    // The refusal has to happen before the URL is built: this request is the
    // moment our client would ask Google for Drive access.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("not available for this account"),
      isKnownError: true,
    });
    expect(getGoogleDriveOAuth2Url).not.toHaveBeenCalled();
  });

  it("builds the consent URL and sets the state cookie when available", async () => {
    isDriveFilingAvailable.mockResolvedValue(true);

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/google/drive/auth-url?access=full",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://accounts.google.com/o",
    });
    expect(getGoogleDriveOAuth2Url).toHaveBeenCalledWith(
      expect.any(String),
      "full",
    );
    expect(response.cookies.get("drive_state")?.value).toBeTruthy();
  });

  it("defaults to limited access", async () => {
    isDriveFilingAvailable.mockResolvedValue(true);

    await GET(
      new NextRequest("http://localhost:3000/api/google/drive/auth-url"),
    );

    expect(getGoogleDriveOAuth2Url).toHaveBeenCalledWith(
      expect.any(String),
      "limited",
    );
  });
});
