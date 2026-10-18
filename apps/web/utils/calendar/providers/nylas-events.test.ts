import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { BookingLinkLocationType } from "@/generated/prisma/enums";
import type { CalendarInvitation } from "@/utils/calendar/invitations/parser";
import { NylasCalendarEventProvider } from "@/utils/calendar/providers/nylas-events";
import { SafeError } from "@/utils/error";

const nylasCalendar = vi.hoisted(() => ({
  listNylasEvents: vi.fn(),
  listNylasEventsWithAttendee: vi.fn(),
  getNylasEvent: vi.fn(),
  findNylasEventByIcalUid: vi.fn(),
  createNylasEvent: vi.fn(),
  updateNylasEvent: vi.fn(),
  deleteNylasEvent: vi.fn(),
  sendNylasRsvp: vi.fn(),
}));

vi.mock("@/utils/nylas/calendar", async (importOriginal) => {
  // The `when` parsing and writing helpers are pure, so they stay real while
  // only the network calls are stubbed.
  const actual =
    await importOriginal<typeof import("@/utils/nylas/calendar")>();
  return { ...actual, ...nylasCalendar };
});

const GRANT_ID = "grant-1";
const CONNECTION_EMAIL = "ada@example.com";
const logger = createTestLogger();

function provider() {
  return new NylasCalendarEventProvider(
    {
      connectionId: "connection-1",
      emailAccountId: "email-account-1",
      grantId: GRANT_ID,
      email: CONNECTION_EMAIL,
    },
    logger,
  );
}

function invitation(overrides: Partial<CalendarInvitation> = {}) {
  return {
    uid: "invite-1@google.com",
    organizer: "grace@example.com",
    attendee: CONNECTION_EMAIL,
    title: "Design review",
    sequence: 0,
    recurrenceId: undefined,
    recurring: false,
    response: null,
    ...overrides,
  } as unknown as CalendarInvitation;
}

function wireEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    title: "Design review",
    description: null,
    location: null,
    when: {
      object: "timespan",
      start_time: 1_767_225_600,
      end_time: 1_767_229_200,
    },
    organizer: { email: "grace@example.com", name: "Grace" },
    participants: [
      { email: CONNECTION_EMAIL, name: "Ada", status: "noreply" },
      { email: "grace@example.com", status: "yes" },
    ],
    status: "confirmed",
    ...overrides,
  };
}

describe("fetchEvents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads the primary calendar with the requested window and limit", async () => {
    nylasCalendar.listNylasEvents.mockResolvedValue({ events: [] });

    await provider().fetchEvents({
      timeMin: new Date("2026-01-01T00:00:00.000Z"),
      timeMax: new Date("2026-01-02T00:00:00.000Z"),
      maxResults: 5,
    });

    expect(nylasCalendar.listNylasEvents).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      calendarId: "primary",
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
      limit: 5,
    });
  });

  it("maps an event onto the shape the rest of the app expects", async () => {
    nylasCalendar.listNylasEvents.mockResolvedValue({
      events: [
        wireEvent({
          text_description: "Agenda attached",
          description: "<p>Agenda attached</p>",
          location: "Room 1",
          html_link: "https://calendar.google.com/event?eid=1",
          conferencing: {
            provider: "Google Meet",
            details: { url: "https://meet.google.com/abc" },
          },
        }),
      ],
    });

    const [event] = await provider().fetchEvents({});

    expect(event).toEqual({
      id: "event-1",
      title: "Design review",
      // The plain-text rendering wins: Nylas may return HTML and appends
      // conference details to the raw description.
      description: "Agenda attached",
      location: "Room 1",
      eventUrl: "https://calendar.google.com/event?eid=1",
      videoConferenceLink: "https://meet.google.com/abc",
      startTime: new Date("2026-01-01T00:00:00.000Z"),
      endTime: new Date("2026-01-01T01:00:00.000Z"),
      organizerEmail: "grace@example.com",
      isOrganizer: false,
      attendees: [
        { email: CONNECTION_EMAIL, name: "Ada", declined: false },
        { email: "grace@example.com", name: undefined, declined: false },
      ],
    });
  });

  it("marks the connected account's own event as organized by it", async () => {
    nylasCalendar.listNylasEvents.mockResolvedValue({
      events: [
        wireEvent({ organizer: { email: "Ada@Example.com", name: "Ada" } }),
      ],
    });

    const [event] = await provider().fetchEvents({});

    expect(event.isOrganizer).toBe(true);
  });

  it("treats a declining participant as declined", async () => {
    nylasCalendar.listNylasEvents.mockResolvedValue({
      events: [
        wireEvent({
          participants: [{ email: CONNECTION_EMAIL, status: "no" }],
        }),
      ],
    });

    const [event] = await provider().fetchEvents({});

    expect(event.attendees).toEqual([
      { email: CONNECTION_EMAIL, name: undefined, declined: true },
    ]);
  });

  it("titles an unnamed event rather than dropping it", async () => {
    nylasCalendar.listNylasEvents.mockResolvedValue({
      events: [wireEvent({ title: null })],
    });

    const [event] = await provider().fetchEvents({});

    expect(event.title).toBe("Untitled");
  });

  it("still returns an event whose timing the provider omitted", async () => {
    nylasCalendar.listNylasEvents.mockResolvedValue({
      events: [wireEvent({ when: null })],
    });

    const [event] = await provider().fetchEvents({});

    // An event we cannot place must not vanish from conflict detection.
    expect(event.startTime).toBeInstanceOf(Date);
    expect(event.endTime).toEqual(event.startTime);
  });

  it("falls back to a link found in the description", async () => {
    nylasCalendar.listNylasEvents.mockResolvedValue({
      events: [
        wireEvent({
          text_description: "Join at https://zoom.us/j/123456789",
        }),
      ],
    });

    const [event] = await provider().fetchEvents({});

    expect(event.videoConferenceLink).toBe("https://zoom.us/j/123456789");
  });

  it("places an all-day event on its days", async () => {
    nylasCalendar.listNylasEvents.mockResolvedValue({
      events: [
        wireEvent({
          when: {
            object: "datespan",
            start_date: "2026-03-01",
            end_date: "2026-03-02",
          },
        }),
      ],
    });

    const [event] = await provider().fetchEvents({});

    expect(event.startTime.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(event.endTime.toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });
});

describe("fetchEventsWithAttendee", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("drops events the provider returned without that attendee", async () => {
    nylasCalendar.listNylasEventsWithAttendee.mockResolvedValue([
      wireEvent({ id: "with-attendee" }),
      wireEvent({
        id: "without-attendee",
        participants: [{ email: "someone@example.com", status: "yes" }],
      }),
    ]);

    const events = await provider().fetchEventsWithAttendee({
      attendeeEmail: CONNECTION_EMAIL,
      timeMin: new Date("2026-01-01T00:00:00.000Z"),
      timeMax: new Date("2026-01-02T00:00:00.000Z"),
      maxResults: 10,
    });

    // Nylas' attendee filter is loose, and the direct Google path re-checks for
    // the same reason, so both transports return the same set.
    expect(events.map((event) => event.id)).toEqual(["with-attendee"]);
    expect(nylasCalendar.listNylasEventsWithAttendee).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      calendarId: "primary",
      attendeeEmail: CONNECTION_EMAIL,
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
      limit: 10,
    });
  });
});

describe("findInvitationEvent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("translates each participant state into the vocabulary the UI matches", async () => {
    const expectations = [
      ["yes", "accepted"],
      ["no", "declined"],
      ["maybe", "tentative"],
      ["noreply", null],
    ] as const;

    for (const [status, expected] of expectations) {
      nylasCalendar.findNylasEventByIcalUid.mockResolvedValue([
        wireEvent({
          participants: [{ email: CONNECTION_EMAIL, status }],
        }),
      ]);

      const match = await provider().findInvitationEvent(invitation());

      // The buttons compare against "accepted" | "declined" | "tentative", so
      // Nylas' own words would leave nothing highlighted.
      expect(match).toEqual({ id: "event-1", response: expected });
    }
  });

  it("does not touch a recurring series", async () => {
    const match = await provider().findInvitationEvent(
      invitation({ recurrenceId: "20260101T000000Z" }),
    );

    expect(match).toBeNull();
    expect(nylasCalendar.findNylasEventByIcalUid).not.toHaveBeenCalled();
  });

  it("reports a cancelled event instead of silently doing nothing", async () => {
    nylasCalendar.findNylasEventByIcalUid.mockResolvedValue([
      wireEvent({ status: "cancelled" }),
    ]);

    await expect(
      provider().findInvitationEvent(invitation()),
    ).rejects.toBeInstanceOf(SafeError);
  });

  it("ignores an invitation the connected account organizes", async () => {
    nylasCalendar.findNylasEventByIcalUid.mockResolvedValue([
      wireEvent({ organizer: { email: CONNECTION_EMAIL } }),
    ]);

    await expect(
      provider().findInvitationEvent(invitation()),
    ).resolves.toBeNull();
  });

  it("ignores an event organized by somebody else", async () => {
    nylasCalendar.findNylasEventByIcalUid.mockResolvedValue([
      wireEvent({ organizer: { email: "other@example.com" } }),
    ]);

    await expect(
      provider().findInvitationEvent(invitation()),
    ).resolves.toBeNull();
  });

  it("ignores an event the attendee is not on", async () => {
    nylasCalendar.findNylasEventByIcalUid.mockResolvedValue([
      wireEvent({ participants: [{ email: "grace@example.com" }] }),
    ]);

    await expect(
      provider().findInvitationEvent(invitation()),
    ).resolves.toBeNull();
  });

  it("refuses to guess when a UID matches several events", async () => {
    nylasCalendar.findNylasEventByIcalUid.mockResolvedValue([
      wireEvent({ id: "one" }),
      wireEvent({ id: "two" }),
    ]);

    await expect(
      provider().findInvitationEvent(invitation()),
    ).resolves.toBeNull();
  });

  it("ignores occurrences so a series is never partially updated", async () => {
    nylasCalendar.findNylasEventByIcalUid.mockResolvedValue([
      wireEvent({ id: "master" }),
      wireEvent({ id: "occurrence", master_event_id: "master" }),
    ]);

    const match = await provider().findInvitationEvent(invitation());

    expect(match).toEqual({ id: "master", response: null });
  });

  it("uses the mailbox event id when the message carried one", async () => {
    nylasCalendar.getNylasEvent.mockResolvedValue(
      wireEvent({ id: "from-mail" }),
    );

    const match = await provider().findInvitationEvent(
      invitation(),
      "from-mail",
    );

    expect(match).toEqual({ id: "from-mail", response: null });
    expect(nylasCalendar.getNylasEvent).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      eventId: "from-mail",
      calendarId: "primary",
    });
    expect(nylasCalendar.findNylasEventByIcalUid).not.toHaveBeenCalled();
  });
});

describe("respondToInvitation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("answers with the RSVP status Nylas expects", async () => {
    await provider().respondToInvitation("event-1", invitation(), "tentative");

    expect(nylasCalendar.sendNylasRsvp).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      eventId: "event-1",
      calendarId: "primary",
      status: "maybe",
    });
  });

  it("turns a decline into Nylas' no", async () => {
    await provider().respondToInvitation("event-1", invitation(), "declined");

    expect(nylasCalendar.sendNylasRsvp).toHaveBeenCalledWith(
      expect.objectContaining({ status: "no" }),
    );
  });
});

describe("createEvent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const input = {
    calendarId: "ada@example.com",
    title: "Design review",
    description: "Agenda",
    startTime: new Date("2026-01-01T00:00:00.000Z"),
    endTime: new Date("2026-01-01T01:00:00.000Z"),
    timezone: "America/New_York",
    attendees: [{ email: "grace@example.com", name: "Grace" }],
  };

  it("asks the provider for a Meet link and leaves the location free", async () => {
    nylasCalendar.createNylasEvent.mockResolvedValue({
      id: "event-1",
      html_link: "https://calendar.google.com/event?eid=1",
      conferencing: { details: { url: "https://meet.google.com/abc" } },
    });

    const created = await provider().createEvent({
      ...input,
      locationType: BookingLinkLocationType.GOOGLE_MEET,
      locationValue: "ignored",
    });

    expect(nylasCalendar.createNylasEvent).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      calendarId: "ada@example.com",
      body: expect.objectContaining({
        title: "Design review",
        location: undefined,
        conferencing: { provider: "Google Meet", autocreate: {} },
        when: {
          object: "timespan",
          start_time: 1_767_225_600,
          end_time: 1_767_229_200,
          start_timezone: "America/New_York",
          end_timezone: "America/New_York",
        },
        participants: [{ email: "grace@example.com", name: "Grace" }],
      }),
    });

    expect(created).toEqual({
      id: "event-1",
      providerCalendarId: "ada@example.com",
      eventUrl: "https://calendar.google.com/event?eid=1",
      videoConferenceLink: "https://meet.google.com/abc",
    });
  });

  it("keeps a plain location when no conference was asked for", async () => {
    nylasCalendar.createNylasEvent.mockResolvedValue({ id: "event-2" });

    await provider().createEvent({
      ...input,
      locationType: BookingLinkLocationType.IN_PERSON,
      locationValue: "Room 1",
    });

    expect(nylasCalendar.createNylasEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          location: "Room 1",
          conferencing: undefined,
        }),
      }),
    );
  });

  it("fails loudly when the provider returns no event", async () => {
    nylasCalendar.createNylasEvent.mockResolvedValue(null);

    await expect(
      provider().createEvent({
        ...input,
        locationType: BookingLinkLocationType.IN_PERSON,
      }),
    ).rejects.toBeInstanceOf(SafeError);
  });
});

describe("update and cancel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("moves an event on its own calendar", async () => {
    nylasCalendar.updateNylasEvent.mockResolvedValue({ id: "event-1" });

    await provider().updateEvent({
      calendarId: "primary",
      eventId: "event-1",
      startTime: new Date("2026-01-01T02:00:00.000Z"),
      endTime: new Date("2026-01-01T03:00:00.000Z"),
      timezone: "UTC",
    });

    expect(nylasCalendar.updateNylasEvent).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      eventId: "event-1",
      calendarId: "primary",
      body: {
        when: {
          object: "timespan",
          start_time: 1_767_232_800,
          end_time: 1_767_236_400,
          start_timezone: "UTC",
          end_timezone: "UTC",
        },
      },
    });
  });

  it("deletes an event from its own calendar", async () => {
    nylasCalendar.deleteNylasEvent.mockResolvedValue(undefined);

    await provider().cancelEvent({
      calendarId: "primary",
      eventId: "event-1",
    });

    expect(nylasCalendar.deleteNylasEvent).toHaveBeenCalledWith({
      grantId: GRANT_ID,
      eventId: "event-1",
      calendarId: "primary",
    });
  });
});
