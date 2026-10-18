import { NYLAS_MAX_PAGE_SIZE, nylasFetch } from "@/utils/nylas/client";

export type NylasCalendar = {
  id: string;
  name?: string | null;
  description?: string | null;
  timezone?: string | null;
  is_primary?: boolean | null;
  read_only?: boolean | null;
};

/**
 * Nylas represents event timing as one of three shapes: `timespan` for timed
 * events, `datespan` for all-day events, and `date` for a single all-day day.
 */
export type NylasEventWhen = {
  object?: string | null;
  start_time?: number | null;
  end_time?: number | null;
  start_timezone?: string | null;
  end_timezone?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  date?: string | null;
};

export type NylasEventParticipant = {
  email?: string | null;
  name?: string | null;
  /** `yes` | `no` | `maybe` | `noreply` */
  status?: string | null;
};

export type NylasEvent = {
  id: string;
  calendar_id?: string | null;
  title?: string | null;
  /** May be HTML; `text_description` is the plain-text rendering. */
  description?: string | null;
  text_description?: string | null;
  location?: string | null;
  when?: NylasEventWhen | null;
  organizer?: { email?: string | null; name?: string | null } | null;
  participants?: NylasEventParticipant[] | null;
  conferencing?: {
    provider?: string | null;
    details?: { url?: string | null; meeting_code?: string | null } | null;
  } | null;
  html_link?: string | null;
  ical_uid?: string | null;
  /** `confirmed` | `cancelled` | `maybe` */
  status?: string | null;
  read_only?: boolean | null;
  master_event_id?: string | null;
};

export type NylasEventWriteBody = {
  title?: string;
  description?: string;
  location?: string;
  when?: NylasEventWhen;
  participants?: Array<{ email: string; name?: string }>;
  conferencing?: NylasConferencing;
  busy?: boolean;
};

/**
 * Nylas asks the provider to generate the conference. Google Meet needs no
 * conference grant of its own — the docs show `autocreate: {}` — so
 * `conf_grant_id` is only set for the providers that do (Zoom).
 *
 * Nylas cannot autocreate across platforms: a Google Calendar event cannot be
 * given a Teams conference, and only Zoom is platform-agnostic.
 */
export type NylasConferencing = {
  provider: string;
  autocreate?: {
    conf_grant_id?: string;
    conf_settings?: { settings?: Record<string, unknown> };
  };
};

export type NylasFreeBusySlot = {
  start_time: number;
  end_time: number;
  status?: string | null;
};

/** One entry per requested address; `error` replaces `time_slots` when it failed. */
export type NylasFreeBusy = {
  email: string;
  time_slots?: NylasFreeBusySlot[] | null;
  error?: string | null;
};

export async function listNylasCalendars({
  grantId,
  pageToken,
}: {
  grantId: string;
  pageToken?: string;
}) {
  const response = await nylasFetch<{
    data?: NylasCalendar[];
    next_cursor?: string | null;
  }>({
    path: `/grants/${grantId}/calendars`,
    query: { limit: NYLAS_MAX_PAGE_SIZE, page_token: pageToken },
  });

  return {
    calendars: response.data ?? [],
    nextCursor: response.next_cursor ?? null,
  };
}

/**
 * `calendar_id` is required by Nylas, so callers always name a calendar.
 *
 * `ical_uid` and `attendees` are exclusive: Nylas refuses a request that combines
 * the UID filter with any other, which is why each has its own call shape here
 * rather than sharing one options bag.
 */
export async function listNylasEvents({
  grantId,
  calendarId,
  start,
  end,
  limit,
  pageToken,
  showCancelled,
}: {
  grantId: string;
  calendarId: string;
  start?: Date;
  end?: Date;
  limit?: number;
  pageToken?: string;
  showCancelled?: boolean;
}) {
  const response = await nylasFetch<{
    data?: NylasEvent[];
    next_cursor?: string | null;
  }>({
    path: `/grants/${grantId}/events`,
    query: {
      calendar_id: calendarId,
      start: start ? toUnixSeconds(start) : undefined,
      end: end ? toUnixSeconds(end) : undefined,
      limit,
      page_token: pageToken,
      show_cancelled: showCancelled,
    },
  });

  return {
    events: response.data ?? [],
    nextCursor: response.next_cursor ?? null,
  };
}

export async function findNylasEventByIcalUid({
  grantId,
  icalUid,
  showCancelled,
}: {
  grantId: string;
  icalUid: string;
  showCancelled?: boolean;
}) {
  // Nylas documents `ical_uid` as "you cannot apply other filters if you use
  // this parameter", while `calendar_id` is documented as required on the same
  // endpoint. The two statements contradict each other and the docs do not
  // resolve which wins, so this sends the UID alone — adding a calendar would
  // mean guessing which calendar the invitation landed on, and answering "not
  // found" because it sits on a secondary calendar would be worse than an error.
  const response = await nylasFetch<{ data?: NylasEvent[] }>({
    path: `/grants/${grantId}/events`,
    query: { ical_uid: icalUid, show_cancelled: showCancelled },
  });

  return response.data ?? [];
}

export async function listNylasEventsWithAttendee({
  grantId,
  calendarId,
  attendeeEmail,
  start,
  end,
  limit,
}: {
  grantId: string;
  calendarId: string;
  attendeeEmail: string;
  start: Date;
  end: Date;
  limit: number;
}) {
  const response = await nylasFetch<{
    data?: NylasEvent[];
    next_cursor?: string | null;
  }>({
    path: `/grants/${grantId}/events`,
    query: {
      calendar_id: calendarId,
      attendees: attendeeEmail,
      start: toUnixSeconds(start),
      end: toUnixSeconds(end),
      limit,
    },
  });

  return response.data ?? [];
}

export async function getNylasEvent({
  grantId,
  eventId,
  calendarId,
}: {
  grantId: string;
  eventId: string;
  calendarId: string;
}) {
  const response = await nylasFetch<{ data?: NylasEvent }>({
    path: `/grants/${grantId}/events/${encodeURIComponent(eventId)}`,
    query: { calendar_id: calendarId },
  });

  return response.data ?? null;
}

export async function createNylasEvent({
  grantId,
  calendarId,
  body,
  notifyParticipants,
}: {
  grantId: string;
  calendarId: string;
  body: NylasEventWriteBody;
  notifyParticipants?: boolean;
}) {
  const response = await nylasFetch<{ data?: NylasEvent }>({
    path: `/grants/${grantId}/events`,
    method: "POST",
    query: { calendar_id: calendarId, notify_participants: notifyParticipants },
    body,
  });

  return response.data ?? null;
}

export async function updateNylasEvent({
  grantId,
  eventId,
  calendarId,
  body,
}: {
  grantId: string;
  eventId: string;
  calendarId: string;
  body: NylasEventWriteBody;
}) {
  const response = await nylasFetch<{ data?: NylasEvent }>({
    path: `/grants/${grantId}/events/${encodeURIComponent(eventId)}`,
    method: "PUT",
    query: { calendar_id: calendarId },
    body,
  });

  return response.data ?? null;
}

export async function deleteNylasEvent({
  grantId,
  eventId,
  calendarId,
}: {
  grantId: string;
  eventId: string;
  calendarId: string;
}) {
  await nylasFetch<unknown>({
    path: `/grants/${grantId}/events/${encodeURIComponent(eventId)}`,
    method: "DELETE",
    query: { calendar_id: calendarId },
  });
}

/**
 * Answers an invitation. Nylas emails the reply to the organizer from the user's
 * own calendar account, which is what an RSVP from their calendar would do.
 */
export async function sendNylasRsvp({
  grantId,
  eventId,
  calendarId,
  status,
}: {
  grantId: string;
  eventId: string;
  calendarId: string;
  status: "yes" | "no" | "maybe";
}) {
  await nylasFetch<unknown>({
    path: `/grants/${grantId}/events/${encodeURIComponent(eventId)}/send-rsvp`,
    method: "POST",
    query: { calendar_id: calendarId },
    body: { status },
  });
}

/**
 * Busy blocks per address.
 *
 * Nylas answers per *person*, not per calendar: the blocks are the ones on that
 * person's primary calendar. A connection's secondary calendars cannot be asked
 * about here, which is a narrower answer than the direct Google free/busy call.
 */
export async function fetchNylasFreeBusy({
  grantId,
  emails,
  startTime,
  endTime,
}: {
  grantId: string;
  emails: string[];
  startTime: Date;
  endTime: Date;
}) {
  const response = await nylasFetch<
    { data?: NylasFreeBusy[] } | NylasFreeBusy[]
  >({
    path: `/grants/${grantId}/calendars/free-busy`,
    method: "POST",
    body: {
      start_time: toUnixSeconds(startTime),
      end_time: toUnixSeconds(endTime),
      emails,
    },
  });

  // The single-address form answers with a bare array while the multi-address
  // form wraps it in `data`; accept both rather than depending on the count.
  return Array.isArray(response) ? response : (response.data ?? []);
}

export function toUnixSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Start and end as instants.
 *
 * For all-day events the provider sets `end_date` to the day *after* the last
 * day, and the direct Google path passes that convention through unchanged, so
 * this deliberately does not normalise it — the two transports have to agree.
 */
export function parseNylasWhen(when: NylasEventWhen | null | undefined) {
  if (!when) return null;

  if (when.start_time != null) {
    return {
      startTime: new Date(when.start_time * 1000),
      endTime: new Date((when.end_time ?? when.start_time) * 1000),
    };
  }

  const startDate = when.start_date ?? when.date;
  if (!startDate) return null;

  return {
    startTime: new Date(startDate),
    endTime: new Date(when.end_date ?? startDate),
  };
}

export function toNylasWhen({
  startTime,
  endTime,
  timezone,
}: {
  startTime: Date;
  endTime: Date;
  timezone: string;
}): NylasEventWhen {
  return {
    object: "timespan",
    start_time: toUnixSeconds(startTime),
    end_time: toUnixSeconds(endTime),
    start_timezone: timezone,
    end_timezone: timezone,
  };
}
