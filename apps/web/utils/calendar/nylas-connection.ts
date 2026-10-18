import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { autoPopulateTimezone } from "@/utils/calendar/timezone-helpers";
import { listNylasCalendars, type NylasCalendar } from "@/utils/nylas/calendar";
import { isNylasErrorWithStatus } from "@/utils/nylas/client";

/** Generous: a mailbox with a thousand calendars still syncs in one connect. */
const MAX_CALENDAR_PAGES = 5;

/**
 * Gives the user's Nylas Google mailboxes a calendar connection, so connecting
 * mail is also what connects the calendar — there is no second consent screen
 * and nothing extra for the user to do.
 *
 * Idempotent: re-linking a mailbox updates the existing connection (including
 * one previously created by the direct Google flow) rather than adding another.
 */
export async function ensureNylasCalendarConnections({
  userId,
  logger,
}: {
  userId: string;
  logger: Logger;
}) {
  const accounts = await prisma.account.findMany({
    where: { userId, transport: "nylas", provider: "google" },
    select: {
      providerAccountId: true,
      emailAccount: { select: { id: true, email: true } },
    },
  });

  for (const account of accounts) {
    const emailAccount = account.emailAccount;
    if (!emailAccount || !account.providerAccountId) continue;

    try {
      await ensureNylasCalendarConnection({
        emailAccountId: emailAccount.id,
        email: emailAccount.email,
        grantId: account.providerAccountId,
        logger,
      });
    } catch (error) {
      // One mailbox failing must not stop the others, and must not fail the
      // linking the user is waiting on.
      logger.error("Failed to connect a Nylas calendar", {
        error,
        emailAccountId: emailAccount.id,
      });
    }
  }
}

/**
 * Creates or refreshes the calendar connection for one grant and syncs its
 * calendars. Returns the connection id, or null when the grant cannot see a
 * calendar at all.
 */
export async function ensureNylasCalendarConnection({
  emailAccountId,
  email,
  grantId,
  logger,
}: {
  emailAccountId: string;
  email: string;
  grantId: string;
  logger: Logger;
}) {
  let calendars: NylasCalendar[];
  try {
    calendars = await listAllNylasCalendars({ grantId });
  } catch (error) {
    // A connector without the calendar scopes answers 403. That is a missing
    // feature, not a fault, and it means there is no calendar to connect — so
    // no connection is written and the calendar features stay absent rather
    // than appearing and failing.
    if (isNylasErrorWithStatus(error, 403)) {
      logger.info("Nylas grant has no calendar access", { grantId });
      return null;
    }
    throw error;
  }

  const connection = await prisma.calendarConnection.upsert({
    where: {
      emailAccountId_provider_email: {
        emailAccountId,
        provider: "google",
        email,
      },
    },
    create: {
      emailAccountId,
      provider: "google",
      email,
      transport: "nylas",
      grantId,
      isConnected: true,
    },
    update: { transport: "nylas", grantId, isConnected: true },
    select: { id: true },
  });

  for (const calendar of calendars) {
    if (!calendar.id) continue;

    const name = calendar.name || "Untitled Calendar";
    const description = calendar.description ?? undefined;
    const timezone = calendar.timezone ?? undefined;
    const primary = calendar.is_primary ?? false;

    await prisma.calendar.upsert({
      where: {
        connectionId_calendarId: {
          connectionId: connection.id,
          calendarId: calendar.id,
        },
      },
      update: { name, description, timezone, primary },
      create: {
        connectionId: connection.id,
        calendarId: calendar.id,
        name,
        description,
        timezone,
        primary,
        isEnabled: true,
      },
    });
  }

  await autoPopulateTimezone(
    emailAccountId,
    calendars.map((calendar) => ({
      // Nylas names these differently from both other providers.
      timeZone: calendar.timezone,
      primary: calendar.is_primary,
    })),
    logger,
  );

  return connection.id;
}

async function listAllNylasCalendars({ grantId }: { grantId: string }) {
  const calendars: NylasCalendar[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_CALENDAR_PAGES; page++) {
    const response = await listNylasCalendars({ grantId, pageToken });
    calendars.push(...response.calendars);

    if (!response.nextCursor) break;
    pageToken = response.nextCursor;
  }

  return calendars;
}
