import { BookingLinkLocationType } from "@/generated/prisma/enums";
import type {
  CalendarEvent,
  CalendarEventCancelInput,
  CalendarEventProvider,
  CalendarEventUpdateInput,
  CalendarEventWriteInput,
  CalendarEventWriteResult,
} from "@/utils/calendar/event-types";
import type {
  CalendarInvitation,
  InvitationEvent,
  InvitationResponse,
} from "@/utils/calendar/invitations/parser";
import { findVideoConferenceLink } from "@/utils/calendar/video-conference-link";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import {
  createNylasEvent,
  deleteNylasEvent,
  findNylasEventByIcalUid,
  getNylasEvent,
  type NylasEvent,
  listNylasEvents,
  listNylasEventsWithAttendee,
  parseNylasWhen,
  sendNylasRsvp,
  toNylasWhen,
  updateNylasEvent,
} from "@/utils/nylas/calendar";

/**
 * Reads go to the primary calendar, which is what the direct Google provider
 * does too. Nylas requires the wider `/auth/calendar` scope for the `primary`
 * keyword, as opposed to the narrower `calendar.events*` scopes.
 */
const PRIMARY_CALENDAR_ID = "primary";

/**
 * The UI highlights the button matching the invitation's response, and it
 * matches Google's vocabulary ("accepted" | "declined" | "tentative"), so
 * Nylas' "yes" | "no" | "maybe" is translated rather than passed through.
 */
const RESPONSE_BY_NYLAS_STATUS: Record<string, InvitationResponse> = {
  yes: "accepted",
  no: "declined",
  maybe: "tentative",
};

const NYLAS_RSVP_BY_RESPONSE: Record<
  InvitationResponse,
  "yes" | "no" | "maybe"
> = {
  accepted: "yes",
  declined: "no",
  tentative: "maybe",
};

export interface NylasCalendarConnectionParams {
  connectionId: string;
  /** The connected calendar account's own address. */
  email: string;
  emailAccountId: string;
  /** The grant every call is scoped to. Tokens are null for this transport. */
  grantId: string;
}

export class NylasCalendarEventProvider implements CalendarEventProvider {
  private readonly connection: NylasCalendarConnectionParams;
  private readonly logger: Logger;

  constructor(connection: NylasCalendarConnectionParams, logger: Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  async fetchEvents({
    timeMin = new Date(),
    timeMax,
    maxResults,
  }: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
  }): Promise<CalendarEvent[]> {
    const { events } = await listNylasEvents({
      grantId: this.connection.grantId,
      calendarId: PRIMARY_CALENDAR_ID,
      start: timeMin,
      end: timeMax,
      limit: maxResults || 10,
    });

    this.logger.info("Completed Nylas calendar events request", {
      eventCount: events.length,
    });

    return events.map((event) => this.parseEvent(event));
  }

  async fetchEventsWithAttendee({
    attendeeEmail,
    timeMin,
    timeMax,
    maxResults,
  }: {
    attendeeEmail: string;
    timeMin: Date;
    timeMax: Date;
    maxResults: number;
  }): Promise<CalendarEvent[]> {
    const events = await listNylasEventsWithAttendee({
      grantId: this.connection.grantId,
      calendarId: PRIMARY_CALENDAR_ID,
      attendeeEmail,
      start: timeMin,
      end: timeMax,
      limit: maxResults,
    });

    // Nylas filters by attendee, but the direct Google provider still re-checks
    // the attendee list because its `q` filter matches loosely; doing the same
    // keeps the two transports returning the same set.
    return events
      .filter((event) =>
        event.participants?.some(
          (participant) =>
            participant.email?.toLowerCase() === attendeeEmail.toLowerCase(),
        ),
      )
      .map((event) => this.parseEvent(event));
  }

  /**
   * Finds the calendar copy of an invitation.
   *
   * Unlike Google (which exposes a `sequence`) and Microsoft (which carries the
   * sequence in an extended property), Nylas returns no revision, so an
   * invitation that changed after this response was written cannot be detected
   * here. The response is applied to the event's current state instead.
   */
  async findInvitationEvent(
    invitation: CalendarInvitation,
    mailboxEventId?: string,
  ): Promise<InvitationEvent | null> {
    // An exception must never accidentally update the whole recurring series.
    if (invitation.recurrenceId) return null;

    const event = mailboxEventId
      ? await getNylasEvent({
          grantId: this.connection.grantId,
          eventId: mailboxEventId,
          calendarId: PRIMARY_CALENDAR_ID,
        })
      : await this.findEventByUid(invitation.uid);

    if (!event) return null;
    if (event.status === "cancelled")
      throw new SafeError("This event has been cancelled.");
    if (!event.id) return null;
    if (this.isOrganizer(event)) return null;
    if (
      event.organizer?.email?.toLowerCase() !== invitation.organizer ||
      !event.participants?.some(
        (participant) =>
          participant.email?.toLowerCase() === invitation.attendee,
      )
    )
      return null;

    const status = event.participants?.find(
      (participant) => participant.email?.toLowerCase() === invitation.attendee,
    )?.status;

    return {
      id: event.id,
      // "noreply" means no answer yet, which the UI shows as nothing selected.
      response: status ? (RESPONSE_BY_NYLAS_STATUS[status] ?? null) : null,
    };
  }

  async respondToInvitation(
    eventId: string,
    _invitation: CalendarInvitation,
    response: InvitationResponse,
  ) {
    await sendNylasRsvp({
      grantId: this.connection.grantId,
      eventId,
      calendarId: PRIMARY_CALENDAR_ID,
      status: NYLAS_RSVP_BY_RESPONSE[response],
    });
  }

  async createEvent(
    input: CalendarEventWriteInput,
  ): Promise<CalendarEventWriteResult> {
    const useGoogleMeet =
      input.locationType === BookingLinkLocationType.GOOGLE_MEET;

    const event = await createNylasEvent({
      grantId: this.connection.grantId,
      calendarId: input.calendarId,
      body: {
        title: input.title,
        description: input.description,
        location: useGoogleMeet ? undefined : input.locationValue || undefined,
        when: toNylasWhen({
          startTime: input.startTime,
          endTime: input.endTime,
          timezone: input.timezone,
        }),
        participants: input.attendees.map((attendee) => ({
          email: attendee.email,
          name: attendee.name,
        })),
        conferencing: useGoogleMeet
          ? { provider: "Google Meet", autocreate: {} }
          : undefined,
      },
    });

    if (!event?.id) {
      throw new SafeError("Nylas did not return the created event.");
    }

    return {
      id: event.id,
      providerCalendarId: input.calendarId,
      eventUrl: event.html_link || undefined,
      videoConferenceLink: event.conferencing?.details?.url || undefined,
    };
  }

  async cancelEvent(input: CalendarEventCancelInput): Promise<void> {
    await deleteNylasEvent({
      grantId: this.connection.grantId,
      eventId: input.eventId,
      calendarId: input.calendarId,
    });
  }

  async updateEvent(input: CalendarEventUpdateInput): Promise<void> {
    await updateNylasEvent({
      grantId: this.connection.grantId,
      eventId: input.eventId,
      calendarId: input.calendarId,
      body: {
        when: toNylasWhen({
          startTime: input.startTime,
          endTime: input.endTime,
          timezone: input.timezone,
        }),
      },
    });
  }

  private async findEventByUid(uid: string) {
    const events = await findNylasEventByIcalUid({
      grantId: this.connection.grantId,
      icalUid: uid,
    });

    // Occurrences of a recurring series can share a UID, so more than one match
    // means we cannot tell which event the invitation refers to.
    const master = events.filter((event) => !event.master_event_id);
    return master.length === 1 ? master[0] : null;
  }

  /**
   * Nylas exposes no "this is you" flag on a Google grant, so the organizer is
   * inferred from the address. Nylas documents that on a primary Google calendar
   * the organizer's address is the calendar id, which is the account's own.
   */
  private isOrganizer(event: NylasEvent) {
    const organizerEmail = event.organizer?.email?.toLowerCase();
    return (
      !!organizerEmail && organizerEmail === this.connection.email.toLowerCase()
    );
  }

  private parseEvent(event: NylasEvent): CalendarEvent {
    const when = parseNylasWhen(event.when);

    // Mirrors the direct Google provider, which falls back to now when the
    // provider omits timing: an unplaceable event still has to be returned.
    const startTime = when?.startTime ?? new Date();
    const endTime = when?.endTime ?? startTime;

    // Nylas may return HTML here and appends conference details to it;
    // `text_description` is the plain-text rendering the reader expects.
    const description =
      event.text_description || event.description || undefined;

    return {
      id: event.id,
      title: event.title || "Untitled",
      description,
      location: event.location || undefined,
      eventUrl: event.html_link || undefined,
      videoConferenceLink:
        event.conferencing?.details?.url ||
        findVideoConferenceLink(event.location, description),
      startTime,
      endTime,
      organizerEmail: event.organizer?.email ?? undefined,
      isOrganizer: this.isOrganizer(event),
      attendees:
        event.participants?.map((participant) => ({
          email: participant.email || "",
          name: participant.name ?? undefined,
          declined: participant.status === "no",
        })) || [],
    };
  }
}
