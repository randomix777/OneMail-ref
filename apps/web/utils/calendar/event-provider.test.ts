import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import {
  createCalendarEventProvider,
  hasUsableCalendarConnection,
} from "@/utils/calendar/event-provider";
import { NylasCalendarEventProvider } from "@/utils/calendar/providers/nylas-events";
import { GoogleCalendarEventProvider } from "@/utils/calendar/providers/google-events";
import { SafeError } from "@/utils/error";

const prisma = vi.hoisted(() => ({
  calendarConnection: { findMany: vi.fn() },
}));

vi.mock("@/utils/prisma", () => ({ default: prisma }));

const logger = createTestLogger();

/**
 * A Google calendar on the Nylas transport: the family still says "google", and
 * there are no tokens of ours because the grant holds them.
 */
const NYLAS_CONNECTION = {
  id: "connection-nylas",
  provider: "google",
  transport: "nylas",
  grantId: "grant-1",
  email: "ada@example.com",
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
};

const GOOGLE_OAUTH_CONNECTION = {
  id: "connection-google",
  provider: "google",
  transport: "oauth",
  grantId: null,
  email: "ada@example.com",
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: null,
};

describe("createCalendarEventProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("builds a Nylas provider for a grant-backed Google calendar", () => {
    const provider = createCalendarEventProvider({
      connection: NYLAS_CONNECTION,
      emailAccountId: "email-account-1",
      logger,
    });

    // The transport decides, not the provider family: the family would otherwise
    // build the Google client with nothing to authenticate with.
    expect(provider).toBeInstanceOf(NylasCalendarEventProvider);
  });

  it("still builds the Google client for a token-backed calendar", () => {
    const provider = createCalendarEventProvider({
      connection: GOOGLE_OAUTH_CONNECTION,
      emailAccountId: "email-account-1",
      logger,
    });

    expect(provider).toBeInstanceOf(GoogleCalendarEventProvider);
  });

  it("refuses a Nylas connection that lost its grant", () => {
    expect(() =>
      createCalendarEventProvider({
        connection: { ...NYLAS_CONNECTION, grantId: null },
        emailAccountId: "email-account-1",
        logger,
      }),
    ).toThrow(SafeError);
  });
});

describe("hasUsableCalendarConnection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("counts a grant-backed connection even without a refresh token", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([NYLAS_CONNECTION]);

    // Requiring a refresh token here would report "no calendar connected" for
    // every Google account moved onto Nylas.
    await expect(hasUsableCalendarConnection("email-account-1")).resolves.toBe(
      true,
    );
  });

  it("still requires a token for the direct transports", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      { ...GOOGLE_OAUTH_CONNECTION, refreshToken: null },
    ]);

    await expect(hasUsableCalendarConnection("email-account-1")).resolves.toBe(
      false,
    );
  });

  it("does not count a Nylas connection with no grant", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      { ...NYLAS_CONNECTION, grantId: null },
    ]);

    await expect(hasUsableCalendarConnection("email-account-1")).resolves.toBe(
      false,
    );
  });
});
