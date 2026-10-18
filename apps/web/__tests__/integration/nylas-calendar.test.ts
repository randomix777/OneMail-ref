/**
 * Integration test: the Nylas calendar path
 *
 * Drives the real calendar provider and availability provider over the fake v3
 * API, so the mapping between Nylas' schema and ours is exercised end to end
 * rather than against a stub.
 *
 * Usage:
 *   pnpm test-integration nylas-calendar
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { BookingLinkLocationType } from "@/generated/prisma/enums";
import { NylasCalendarEventProvider } from "@/utils/calendar/providers/nylas-events";
import { createNylasAvailabilityProvider } from "@/utils/calendar/providers/nylas-availability";
import type { CalendarInvitation } from "@/utils/calendar/invitations/parser";
import { createTestLogger } from "@/__tests__/helpers";
import { createNylasTestHarness, type NylasTestHarness } from "./helpers";

vi.mock("server-only", () => ({}));

// `@/env` validates on first evaluation and the Nylas transport reads its URI
// and key from it, so they have to be in place before the imports above resolve.
// Guarded so a run that skips these tests never touches the environment.
vi.hoisted(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    process.env.NYLAS_API_KEY = "test-nylas-api-key";
    process.env.NYLAS_API_URI = "https://nylas.test";
  }
});

afterAll(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    delete process.env.NYLAS_API_KEY;
    delete process.env.NYLAS_API_URI;
  }
});

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const OWNER = "owner@example.com";
const logger = createTestLogger();

const REVIEW_START = new Date("2026-03-02T15:00:00.000Z");
const REVIEW_END = new Date("2026-03-02T16:00:00.000Z");

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Nylas calendar",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;
    /** The agenda as seeded, so a test that writes does not affect the next. */
    let seededEvents: NylasTestHarness["events"];

    beforeAll(async () => {
      harness = await createNylasTestHarness({
        messages: [],
        email: OWNER,
        calendars: [
          { id: OWNER, name: "Owner", isPrimary: true, timezone: "UTC" },
          {
            id: "team@group.calendar.google.com",
            name: "Team",
            isPrimary: false,
          },
        ],
        events: [
          {
            id: "event-review",
            title: "Design review",
            description: "Agenda attached",
            location: "Room 1",
            startTime: REVIEW_START,
            endTime: REVIEW_END,
            timezone: "UTC",
            organizerEmail: "grace@example.com",
            participants: [
              { email: OWNER, name: "Ada", status: "noreply" },
              { email: "grace@example.com", status: "yes" },
            ],
            icalUid: "review@google.com",
            conferencingUrl: "https://meet.google.com/review",
          },
          {
            id: "event-busy",
            title: "Standup",
            startTime: new Date("2026-03-02T09:00:00.000Z"),
            endTime: new Date("2026-03-02T09:15:00.000Z"),
            organizerEmail: OWNER,
            participants: [{ email: OWNER, status: "yes" }],
          },
          {
            id: "event-cancelled",
            title: "Cancelled sync",
            startTime: new Date("2026-03-02T11:00:00.000Z"),
            endTime: new Date("2026-03-02T11:30:00.000Z"),
            status: "cancelled",
            organizerEmail: OWNER,
          },
          {
            id: "event-secondary",
            title: "Team retro",
            calendarId: "team@group.calendar.google.com",
            startTime: new Date("2026-03-02T13:00:00.000Z"),
            endTime: new Date("2026-03-02T14:00:00.000Z"),
            organizerEmail: OWNER,
          },
        ],
      });

      seededEvents = structuredClone(harness.events);
    });

    afterAll(() => {
      harness?.restoreFetch();
    });

    function provider() {
      return new NylasCalendarEventProvider(
        {
          connectionId: "connection-1",
          emailAccountId: "email-account-1",
          grantId: harness.grantId,
          email: OWNER,
        },
        logger,
      );
    }

    beforeEach(() => {
      harness.requests.length = 0;
      // Several tests write to the agenda, so each one starts from the seed
      // rather than from whatever the previous test left behind.
      harness.events.splice(
        0,
        harness.events.length,
        ...structuredClone(seededEvents),
      );
    });

    test("reads the primary calendar's events and maps their fields", async () => {
      const events = await provider().fetchEvents({
        timeMin: new Date("2026-03-02T00:00:00.000Z"),
        timeMax: new Date("2026-03-03T00:00:00.000Z"),
        maxResults: 50,
      });

      const review = events.find((event) => event.id === "event-review");
      expect(review).toMatchObject({
        title: "Design review",
        description: "Agenda attached",
        location: "Room 1",
        eventUrl: "https://calendar.google.com/event?eid=event-review",
        videoConferenceLink: "https://meet.google.com/review",
        organizerEmail: "grace@example.com",
        isOrganizer: false,
        startTime: REVIEW_START,
        endTime: REVIEW_END,
      });
      expect(review?.attendees).toEqual([
        { email: OWNER, name: "Ada", declined: false },
        { email: "grace@example.com", name: undefined, declined: false },
      ]);
    });

    test("leaves out cancelled events and other calendars", async () => {
      const events = await provider().fetchEvents({
        timeMin: new Date("2026-03-02T00:00:00.000Z"),
        timeMax: new Date("2026-03-03T00:00:00.000Z"),
        maxResults: 50,
      });

      const ids = events.map((event) => event.id);
      expect(ids).toContain("event-review");
      expect(ids).not.toContain("event-cancelled");
      // The secondary calendar is not "primary", and reads go to primary.
      expect(ids).not.toContain("event-secondary");
    });

    test("narrows to the requested window", async () => {
      const events = await provider().fetchEvents({
        timeMin: new Date("2026-03-02T14:00:00.000Z"),
        timeMax: new Date("2026-03-02T18:00:00.000Z"),
        maxResults: 50,
      });

      expect(events.map((event) => event.id)).toEqual(["event-review"]);
    });

    test("marks the account's own event as organized by it", async () => {
      const events = await provider().fetchEvents({
        timeMin: new Date("2026-03-02T08:00:00.000Z"),
        timeMax: new Date("2026-03-02T10:00:00.000Z"),
        maxResults: 50,
      });

      expect(events.map((event) => event.id)).toEqual(["event-busy"]);
      expect(events[0].isOrganizer).toBe(true);
    });

    test("filters by attendee through the provider, not on the client", async () => {
      const events = await provider().fetchEventsWithAttendee({
        attendeeEmail: OWNER,
        timeMin: new Date("2026-03-02T00:00:00.000Z"),
        timeMax: new Date("2026-03-03T00:00:00.000Z"),
        maxResults: 50,
      });

      expect(events.map((event) => event.id).sort()).toEqual([
        "event-busy",
        "event-review",
      ]);
      // The request really carried the attendee filter.
      const listRequest = harness.requests.find((request) =>
        request.url.pathname.endsWith("/events"),
      );
      expect(listRequest?.url.searchParams.get("attendees")).toBe(OWNER);
    });

    test("finds an invitation by its iCal UID and answers it", async () => {
      const invitation = {
        uid: "review@google.com",
        organizer: "grace@example.com",
        attendee: OWNER,
        title: "Design review",
        sequence: 0,
        recurrenceId: undefined,
        recurring: false,
        response: null,
      } as unknown as CalendarInvitation;

      const match = await provider().findInvitationEvent(invitation);

      // "noreply" is no answer yet, so nothing is highlighted in the UI.
      expect(match).toEqual({ id: "event-review", response: null });

      await provider().respondToInvitation(match!.id, invitation, "accepted");

      // The RSVP reached the stored event, which is what the calendar would show,
      // and it reads back in the vocabulary the invitation buttons match on.
      const stored = harness.events.find(
        (event) => event.id === "event-review",
      );
      expect(
        stored?.participants.find((participant) => participant.email === OWNER)
          ?.status,
      ).toBe("yes");
      expect(await provider().findInvitationEvent(invitation)).toEqual({
        id: "event-review",
        response: "accepted",
      });
    });

    test("creates an event with a Meet link and invites the attendee", async () => {
      const created = await provider().createEvent({
        calendarId: OWNER,
        title: "Kickoff",
        description: "First one",
        startTime: new Date("2026-03-03T10:00:00.000Z"),
        endTime: new Date("2026-03-03T10:30:00.000Z"),
        timezone: "UTC",
        attendees: [{ email: "grace@example.com", name: "Grace" }],
        locationType: BookingLinkLocationType.GOOGLE_MEET,
      });

      expect(created.id).toBe("event-5");
      expect(created.providerCalendarId).toBe(OWNER);
      expect(created.eventUrl).toBe(
        "https://calendar.google.com/event?eid=event-5",
      );
      // Nylas autocreated the conference, and its URL came back to us.
      expect(created.videoConferenceLink).toBe(
        "https://meet.google.com/event-5",
      );

      const stored = harness.events.find((event) => event.id === "event-5");
      expect(stored).toMatchObject({
        title: "Kickoff",
        calendar_id: OWNER,
        location: null,
      });
      expect(stored?.participants).toEqual([
        { email: "grace@example.com", name: "Grace", status: "noreply" },
      ]);
      expect(stored?.when).toMatchObject({
        start_time: Math.floor(
          new Date("2026-03-03T10:00:00.000Z").getTime() / 1000,
        ),
        end_time: Math.floor(
          new Date("2026-03-03T10:30:00.000Z").getTime() / 1000,
        ),
        start_timezone: "UTC",
      });
    });

    test("moves an existing event", async () => {
      await provider().updateEvent({
        calendarId: OWNER,
        eventId: "event-review",
        startTime: new Date("2026-03-02T17:00:00.000Z"),
        endTime: new Date("2026-03-02T18:00:00.000Z"),
        timezone: "UTC",
      });

      const stored = harness.events.find(
        (event) => event.id === "event-review",
      );
      expect(stored?.when.start_time).toBe(
        Math.floor(new Date("2026-03-02T17:00:00.000Z").getTime() / 1000),
      );
    });

    test("cancels an event", async () => {
      await provider().cancelEvent({
        calendarId: OWNER,
        eventId: "event-busy",
      });

      expect(harness.events.map((event) => event.id)).not.toContain(
        "event-busy",
      );
    });

    test("reads busy periods through free/busy", async () => {
      const busy = await createNylasAvailabilityProvider(
        logger,
      ).fetchBusyPeriods({
        grantId: harness.grantId,
        email: OWNER,
        refreshToken: null,
        expiresAt: null,
        emailAccountId: "email-account-1",
        calendarIds: [OWNER],
        timeMin: "2026-03-02T00:00:00.000Z",
        timeMax: "2026-03-03T00:00:00.000Z",
      });

      // The standup and the review are busy; the cancelled event and the
      // secondary calendar's event are not, because free/busy reports the blocks
      // on each address's own primary calendar.
      expect(
        busy.sort((left, right) => left.start.localeCompare(right.start)),
      ).toEqual([
        {
          start: "2026-03-02T09:00:00.000Z",
          end: "2026-03-02T09:15:00.000Z",
        },
        {
          start: "2026-03-02T15:00:00.000Z",
          end: "2026-03-02T16:00:00.000Z",
        },
      ]);
    });
  },
);
