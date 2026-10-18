import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNylasEvent,
  deleteNylasEvent,
  fetchNylasFreeBusy,
  findNylasEventByIcalUid,
  listNylasCalendars,
  listNylasEvents,
  listNylasEventsWithAttendee,
  parseNylasWhen,
  sendNylasRsvp,
  toNylasWhen,
  updateNylasEvent,
} from "@/utils/nylas/calendar";

const nylasFetch = vi.hoisted(() => vi.fn());

vi.mock("@/utils/nylas/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/nylas/client")>();
  return { ...actual, nylasFetch };
});

const GRANT_ID = "grant-1";

describe("parseNylasWhen", () => {
  it("reads a timed event as instants", () => {
    const when = parseNylasWhen({
      object: "timespan",
      start_time: 1_767_225_600,
      end_time: 1_767_229_200,
    });

    expect(when?.startTime.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(when?.endTime.toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  it("falls back to the start when a timed event has no end", () => {
    const when = parseNylasWhen({
      object: "timespan",
      start_time: 1_767_225_600,
    });

    expect(when?.endTime).toEqual(when?.startTime);
  });

  it("reads a date span as days", () => {
    const when = parseNylasWhen({
      object: "datespan",
      start_date: "2026-01-01",
      end_date: "2026-01-03",
    });

    // The provider's convention is kept as-is: the direct Google path passes the
    // same off-by-one end date through, and the two transports must agree.
    expect(when?.startTime.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(when?.endTime.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });

  it("reads a single all-day date", () => {
    const when = parseNylasWhen({ object: "date", date: "2026-02-14" });

    expect(when?.startTime.toISOString()).toBe("2026-02-14T00:00:00.000Z");
    expect(when?.endTime).toEqual(when?.startTime);
  });

  it("returns nothing when the provider omitted the timing", () => {
    expect(parseNylasWhen(null)).toBeNull();
    expect(parseNylasWhen({ object: "timespan" })).toBeNull();
  });
});

describe("toNylasWhen", () => {
  it("writes unix seconds with the caller's timezone on both ends", () => {
    expect(
      toNylasWhen({
        startTime: new Date("2026-01-01T00:00:00.000Z"),
        endTime: new Date("2026-01-01T01:00:00.000Z"),
        timezone: "America/New_York",
      }),
    ).toEqual({
      object: "timespan",
      start_time: 1_767_225_600,
      end_time: 1_767_229_200,
      start_timezone: "America/New_York",
      end_timezone: "America/New_York",
    });
  });
});

describe("calendar reads", () => {
  beforeEach(() => {
    nylasFetch.mockReset();
  });

  it("pages calendars from the grant's calendar list", async () => {
    nylasFetch.mockResolvedValue({
      data: [{ id: "primary", name: "Ada", is_primary: true }],
      next_cursor: "cursor-2",
    });

    const page = await listNylasCalendars({ grantId: GRANT_ID });

    expect(page.calendars).toHaveLength(1);
    expect(page.nextCursor).toBe("cursor-2");
    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/calendars`,
      query: { limit: 200, page_token: undefined },
    });
  });

  it("sends the window as unix seconds", async () => {
    nylasFetch.mockResolvedValue({ data: [] });

    await listNylasEvents({
      grantId: GRANT_ID,
      calendarId: "primary",
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
      limit: 10,
    });

    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/events`,
      query: {
        calendar_id: "primary",
        start: 1_767_225_600,
        end: 1_767_312_000,
        limit: 10,
        page_token: undefined,
        show_cancelled: undefined,
      },
    });
  });

  it("looks an invitation up by iCal UID without naming a calendar", async () => {
    nylasFetch.mockResolvedValue({ data: [{ id: "event-1" }] });

    const events = await findNylasEventByIcalUid({
      grantId: GRANT_ID,
      icalUid: "abc@google.com",
    });

    expect(events).toHaveLength(1);
    // Nylas documents the UID filter as exclusive of every other filter while
    // also documenting `calendar_id` as required, so the UID goes alone.
    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/events`,
      query: { ical_uid: "abc@google.com", show_cancelled: undefined },
    });
  });

  it("filters events by attendee address", async () => {
    nylasFetch.mockResolvedValue({ data: [] });

    await listNylasEventsWithAttendee({
      grantId: GRANT_ID,
      calendarId: "primary",
      attendeeEmail: "ada@example.com",
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
      limit: 25,
    });

    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/events`,
      query: {
        calendar_id: "primary",
        attendees: "ada@example.com",
        start: 1_767_225_600,
        end: 1_767_312_000,
        limit: 25,
      },
    });
  });
});

describe("calendar writes", () => {
  beforeEach(() => {
    nylasFetch.mockReset();
  });

  it("creates an event on the named calendar and can hold invitations", async () => {
    nylasFetch.mockResolvedValue({ data: { id: "event-1" } });

    const event = await createNylasEvent({
      grantId: GRANT_ID,
      calendarId: "ada@example.com",
      notifyParticipants: false,
      body: {
        title: "Design review",
        when: toNylasWhen({
          startTime: new Date("2026-01-01T00:00:00.000Z"),
          endTime: new Date("2026-01-01T01:00:00.000Z"),
          timezone: "UTC",
        }),
      },
    });

    expect(event?.id).toBe("event-1");
    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/events`,
      method: "POST",
      query: { calendar_id: "ada@example.com", notify_participants: false },
      body: expect.objectContaining({ title: "Design review" }),
    });
  });

  it("updates with PUT, which is the only documented write for an event", async () => {
    nylasFetch.mockResolvedValue({ data: { id: "event-1" } });

    await updateNylasEvent({
      grantId: GRANT_ID,
      eventId: "event-1",
      calendarId: "primary",
      body: { title: "Moved" },
    });

    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/events/event-1`,
      method: "PUT",
      query: { calendar_id: "primary" },
      body: { title: "Moved" },
    });
  });

  it("deletes an event on its calendar", async () => {
    nylasFetch.mockResolvedValue({});

    await deleteNylasEvent({
      grantId: GRANT_ID,
      eventId: "event-1",
      calendarId: "primary",
    });

    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/events/event-1`,
      method: "DELETE",
      query: { calendar_id: "primary" },
    });
  });

  it("escapes an event id and answers the invitation", async () => {
    nylasFetch.mockResolvedValue({});

    await sendNylasRsvp({
      grantId: GRANT_ID,
      eventId: "event/with/slash",
      calendarId: "primary",
      status: "maybe",
    });

    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/events/event%2Fwith%2Fslash/send-rsvp`,
      method: "POST",
      query: { calendar_id: "primary" },
      body: { status: "maybe" },
    });
  });
});

describe("fetchNylasFreeBusy", () => {
  beforeEach(() => {
    nylasFetch.mockReset();
  });

  it("asks per address over unix seconds", async () => {
    nylasFetch.mockResolvedValue({ data: [] });

    await fetchNylasFreeBusy({
      grantId: GRANT_ID,
      emails: ["ada@example.com"],
      startTime: new Date("2026-01-01T00:00:00.000Z"),
      endTime: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/calendars/free-busy`,
      method: "POST",
      body: {
        start_time: 1_767_225_600,
        end_time: 1_767_312_000,
        emails: ["ada@example.com"],
      },
    });
  });

  it("reads the wrapped response", async () => {
    nylasFetch.mockResolvedValue({
      data: [
        {
          email: "ada@example.com",
          time_slots: [{ start_time: 1, end_time: 2, status: "busy" }],
        },
      ],
    });

    const result = await fetchNylasFreeBusy({
      grantId: GRANT_ID,
      emails: ["ada@example.com"],
      startTime: new Date(0),
      endTime: new Date(1),
    });

    expect(result).toHaveLength(1);
    expect(result[0].time_slots).toHaveLength(1);
  });

  it("also reads the bare array the single-address form answers with", async () => {
    // The docs show a bare array for one address and `{ data }` for several, so
    // both envelopes are accepted rather than depending on the count.
    nylasFetch.mockResolvedValue([
      { email: "ada@example.com", time_slots: null },
    ]);

    const result = await fetchNylasFreeBusy({
      grantId: GRANT_ID,
      emails: ["ada@example.com"],
      startTime: new Date(0),
      endTime: new Date(1),
    });

    expect(result).toEqual([{ email: "ada@example.com", time_slots: null }]);
  });
});
