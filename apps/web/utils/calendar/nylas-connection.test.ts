import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import {
  ensureNylasCalendarConnection,
  ensureNylasCalendarConnections,
} from "@/utils/calendar/nylas-connection";
import { NylasApiError } from "@/utils/nylas/client";

const prisma = vi.hoisted(() => ({
  account: { findMany: vi.fn() },
  calendarConnection: { upsert: vi.fn() },
  calendar: { upsert: vi.fn() },
  emailAccount: { updateMany: vi.fn() },
}));

const listNylasCalendars = vi.hoisted(() => vi.fn());

vi.mock("@/utils/prisma", () => ({ default: prisma }));
vi.mock("@/utils/nylas/calendar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/nylas/calendar")>();
  return { ...actual, listNylasCalendars };
});

const logger = createTestLogger();
const GRANT_ID = "grant-1";
const EMAIL = "ada@example.com";

function nylasCalendar(overrides: Record<string, unknown> = {}) {
  return {
    id: "ada@example.com",
    name: "Ada",
    description: null,
    timezone: "America/New_York",
    is_primary: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  prisma.calendarConnection.upsert.mockResolvedValue({ id: "connection-1" });
  prisma.calendar.upsert.mockResolvedValue({});
  prisma.emailAccount.updateMany.mockResolvedValue({ count: 1 });
  listNylasCalendars.mockResolvedValue({
    calendars: [nylasCalendar()],
    nextCursor: null,
  });
});

describe("ensureNylasCalendarConnection", () => {
  it("creates a grant-backed connection and syncs its calendars", async () => {
    const connectionId = await ensureNylasCalendarConnection({
      emailAccountId: "email-account-1",
      email: EMAIL,
      grantId: GRANT_ID,
      logger,
    });

    expect(connectionId).toBe("connection-1");
    expect(prisma.calendarConnection.upsert).toHaveBeenCalledWith({
      where: {
        emailAccountId_provider_email: {
          emailAccountId: "email-account-1",
          provider: "google",
          email: EMAIL,
        },
      },
      create: {
        emailAccountId: "email-account-1",
        provider: "google",
        email: EMAIL,
        transport: "nylas",
        grantId: GRANT_ID,
        isConnected: true,
      },
      update: { transport: "nylas", grantId: GRANT_ID, isConnected: true },
      select: { id: true },
    });

    expect(prisma.calendar.upsert).toHaveBeenCalledWith({
      where: {
        connectionId_calendarId: {
          connectionId: "connection-1",
          calendarId: EMAIL,
        },
      },
      update: {
        name: "Ada",
        description: undefined,
        timezone: "America/New_York",
        primary: true,
      },
      create: {
        connectionId: "connection-1",
        calendarId: EMAIL,
        name: "Ada",
        description: undefined,
        timezone: "America/New_York",
        primary: true,
        isEnabled: true,
      },
    });
  });

  it("relinks the existing row rather than adding a second connection", async () => {
    // The unique key is (emailAccountId, provider, email), so a calendar the
    // direct Google flow created is converted in place.
    await ensureNylasCalendarConnection({
      emailAccountId: "email-account-1",
      email: EMAIL,
      grantId: GRANT_ID,
      logger,
    });

    expect(prisma.calendarConnection.upsert).toHaveBeenCalledOnce();
    expect(
      prisma.calendarConnection.upsert.mock.calls[0][0].create,
    ).toBeDefined();
  });

  it("names an unnamed calendar rather than storing a blank row", async () => {
    listNylasCalendars.mockResolvedValue({
      calendars: [nylasCalendar({ name: null })],
      nextCursor: null,
    });

    await ensureNylasCalendarConnection({
      emailAccountId: "email-account-1",
      email: EMAIL,
      grantId: GRANT_ID,
      logger,
    });

    expect(prisma.calendar.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ name: "Untitled Calendar" }),
      }),
    );
  });

  it("follows the calendar cursor", async () => {
    listNylasCalendars
      .mockResolvedValueOnce({
        calendars: [nylasCalendar()],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        calendars: [nylasCalendar({ id: "team@group.calendar.google.com" })],
        nextCursor: null,
      });

    await ensureNylasCalendarConnection({
      emailAccountId: "email-account-1",
      email: EMAIL,
      grantId: GRANT_ID,
      logger,
    });

    expect(prisma.calendar.upsert).toHaveBeenCalledTimes(2);
    expect(listNylasCalendars.mock.calls[1][0].pageToken).toBe("page-2");
  });

  it("seeds the account timezone from the primary calendar", async () => {
    await ensureNylasCalendarConnection({
      emailAccountId: "email-account-1",
      email: EMAIL,
      grantId: GRANT_ID,
      logger,
    });

    expect(prisma.emailAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "email-account-1", timezone: null },
      data: { timezone: "America/New_York" },
    });
  });

  it("connects nothing when the grant cannot read a calendar", async () => {
    listNylasCalendars.mockRejectedValue(
      new NylasApiError({ status: 403, message: "Forbidden" }),
    );

    // A connector without the calendar scopes is a missing feature: no
    // connection is written, so the calendar features stay absent instead of
    // appearing and then failing.
    await expect(
      ensureNylasCalendarConnection({
        emailAccountId: "email-account-1",
        email: EMAIL,
        grantId: GRANT_ID,
        logger,
      }),
    ).resolves.toBeNull();
    expect(prisma.calendarConnection.upsert).not.toHaveBeenCalled();
  });

  it("surfaces any other failure", async () => {
    listNylasCalendars.mockRejectedValue(
      new NylasApiError({ status: 500, message: "Server error" }),
    );

    await expect(
      ensureNylasCalendarConnection({
        emailAccountId: "email-account-1",
        email: EMAIL,
        grantId: GRANT_ID,
        logger,
      }),
    ).rejects.toBeInstanceOf(NylasApiError);
  });
});

describe("ensureNylasCalendarConnections", () => {
  it("connects every Nylas Google mailbox the user has", async () => {
    prisma.account.findMany.mockResolvedValue([
      {
        providerAccountId: "grant-1",
        emailAccount: { id: "email-account-1", email: "ada@example.com" },
      },
      {
        providerAccountId: "grant-2",
        emailAccount: { id: "email-account-2", email: "grace@example.com" },
      },
    ]);

    await ensureNylasCalendarConnections({ userId: "user-1", logger });

    expect(prisma.calendarConnection.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.account.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", transport: "nylas", provider: "google" },
      select: {
        providerAccountId: true,
        emailAccount: { select: { id: true, email: true } },
      },
    });
  });

  it("skips an account with no mailbox or no grant", async () => {
    prisma.account.findMany.mockResolvedValue([
      { providerAccountId: "grant-1", emailAccount: null },
      {
        providerAccountId: null,
        emailAccount: { id: "email-account-2", email: "grace@example.com" },
      },
    ]);

    await ensureNylasCalendarConnections({ userId: "user-1", logger });

    expect(prisma.calendarConnection.upsert).not.toHaveBeenCalled();
  });

  it("keeps going when one mailbox fails", async () => {
    prisma.account.findMany.mockResolvedValue([
      {
        providerAccountId: "grant-1",
        emailAccount: { id: "email-account-1", email: "ada@example.com" },
      },
      {
        providerAccountId: "grant-2",
        emailAccount: { id: "email-account-2", email: "grace@example.com" },
      },
    ]);
    prisma.calendarConnection.upsert
      .mockRejectedValueOnce(new Error("database is unhappy"))
      .mockResolvedValue({ id: "connection-2" });

    // The user is waiting on a redirect, so one mailbox's failure must not
    // become a failed linking.
    await expect(
      ensureNylasCalendarConnections({ userId: "user-1", logger }),
    ).resolves.toBeUndefined();
    expect(prisma.calendarConnection.upsert).toHaveBeenCalledTimes(2);
  });
});
