import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { CalendarAvailabilityError } from "@/utils/calendar/availability-error";
import { createNylasAvailabilityProvider } from "@/utils/calendar/providers/nylas-availability";

const fetchNylasFreeBusy = vi.hoisted(() => vi.fn());

vi.mock("@/utils/nylas/calendar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/nylas/calendar")>();
  return { ...actual, fetchNylasFreeBusy };
});

const GRANT_ID = "grant-1";
const EMAIL = "ada@example.com";
const logger = createTestLogger();

function fetchBusyPeriods({
  failOnCalendarError,
  grantId = GRANT_ID,
  email = EMAIL,
}: {
  failOnCalendarError?: boolean;
  grantId?: string;
  email?: string;
} = {}) {
  return createNylasAvailabilityProvider(logger).fetchBusyPeriods({
    grantId,
    email,
    refreshToken: null,
    expiresAt: null,
    emailAccountId: "email-account-1",
    calendarIds: ["primary"],
    timeMin: "2026-01-01T00:00:00.000Z",
    timeMax: "2026-01-02T00:00:00.000Z",
    failOnCalendarError,
  });
}

describe("createNylasAvailabilityProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("announces itself as the Nylas transport", () => {
    expect(createNylasAvailabilityProvider(logger).name).toBe("nylas");
  });

  it("asks per address because free/busy is keyed by address", async () => {
    fetchNylasFreeBusy.mockResolvedValue([]);

    await fetchBusyPeriods();

    expect(fetchNylasFreeBusy).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      emails: [EMAIL],
      startTime: new Date("2026-01-01T00:00:00.000Z"),
      endTime: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  it("converts unix seconds into the ISO periods the rest of the app uses", async () => {
    fetchNylasFreeBusy.mockResolvedValue([
      {
        email: EMAIL,
        time_slots: [{ start_time: 1_767_225_600, end_time: 1_767_229_200 }],
      },
    ]);

    await expect(fetchBusyPeriods()).resolves.toEqual([
      { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" },
    ]);
  });

  it("matches the requested address regardless of case", async () => {
    fetchNylasFreeBusy.mockResolvedValue([
      {
        email: "Ada@Example.com",
        time_slots: [{ start_time: 1_767_225_600, end_time: 1_767_229_200 }],
      },
    ]);

    await expect(fetchBusyPeriods()).resolves.toHaveLength(1);
  });

  it("ignores entries for other addresses", async () => {
    fetchNylasFreeBusy.mockResolvedValue([
      {
        email: "someone@example.com",
        time_slots: [{ start_time: 1, end_time: 2 }],
      },
    ]);

    await expect(fetchBusyPeriods()).resolves.toEqual([]);
  });

  it("treats a missing slot list as no busy time", async () => {
    fetchNylasFreeBusy.mockResolvedValue([{ email: EMAIL, time_slots: null }]);

    await expect(fetchBusyPeriods()).resolves.toEqual([]);
  });

  it("reports a per-address failure as a calendar availability error", async () => {
    fetchNylasFreeBusy.mockResolvedValue([
      { email: EMAIL, error: "Unable to resolve the address" },
    ]);

    // Nylas answers 200 and puts the failure in the body, so this is the only
    // place the error can become a real one.
    await expect(
      fetchBusyPeriods({ failOnCalendarError: true }),
    ).rejects.toBeInstanceOf(CalendarAvailabilityError);
  });

  it("degrades to no busy time when the caller tolerates errors", async () => {
    fetchNylasFreeBusy.mockResolvedValue([
      { email: EMAIL, error: "Unable to resolve the address" },
    ]);

    await expect(fetchBusyPeriods()).resolves.toEqual([]);
  });

  it("propagates a transport failure rather than reporting an empty calendar", async () => {
    fetchNylasFreeBusy.mockRejectedValue(new Error("nylas is down"));

    await expect(fetchBusyPeriods()).rejects.toThrow("nylas is down");
  });

  it("fails loudly when the connection has no grant", async () => {
    await expect(fetchBusyPeriods({ grantId: "" })).rejects.toBeInstanceOf(
      CalendarAvailabilityError,
    );
  });

  it("returns nothing when the connection has no address to ask about", async () => {
    await expect(fetchBusyPeriods({ email: "" })).resolves.toEqual([]);
    expect(fetchNylasFreeBusy).not.toHaveBeenCalled();
  });
});
