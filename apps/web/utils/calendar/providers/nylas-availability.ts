import type { Logger } from "@/utils/logger";
import { fetchNylasFreeBusy } from "@/utils/nylas/calendar";
import type {
  BusyPeriod,
  CalendarAvailabilityProvider,
} from "../availability-types";
import {
  CalendarAvailabilityError,
  getCalendarAvailabilityErrorLogContext,
} from "../availability-error";

/**
 * Busy blocks for a Nylas connection.
 *
 * Nylas' free/busy answers per *address*, not per calendar: it returns the
 * blocks on that address's primary calendar. The connection's own address is
 * therefore the only thing that can be asked about, and a connection's secondary
 * calendars cannot be included even when they are enabled locally — a narrower
 * answer than the direct Google free/busy call gives.
 *
 * Nylas always answers 200 and reports a failure for an address inside the body,
 * so the per-address `error` is what becomes a CalendarAvailabilityError.
 */
export function createNylasAvailabilityProvider(
  logger: Logger,
): CalendarAvailabilityProvider {
  return {
    name: "nylas",

    async fetchBusyPeriods({
      grantId,
      email,
      timeMin,
      timeMax,
      failOnCalendarError,
    }) {
      if (!grantId) {
        throw new CalendarAvailabilityError({
          provider: "nylas",
          calendarErrors: [
            {
              calendarId: "unknown",
              errors: [{ message: "Calendar connection has no Nylas grant." }],
            },
          ],
        });
      }

      const address = email;
      if (!address) {
        logger.warn("Nylas calendar connection has no address to check");
        return [];
      }

      const busyPeriods: BusyPeriod[] = [];

      try {
        const results = await fetchNylasFreeBusy({
          grantId,
          emails: [address],
          startTime: new Date(timeMin),
          endTime: new Date(timeMax),
        });

        const entries = results.filter(
          (result) => result.email?.toLowerCase() === address.toLowerCase(),
        );

        for (const entry of entries) {
          if (entry.error) {
            const availabilityError = new CalendarAvailabilityError({
              provider: "nylas",
              calendarErrors: [
                { calendarId: address, errors: [{ message: entry.error }] },
              ],
            });

            logger.error("Nylas returned availability errors", {
              ...getCalendarAvailabilityErrorLogContext(availabilityError),
            });

            if (failOnCalendarError) throw availabilityError;
            continue;
          }

          for (const slot of entry.time_slots ?? []) {
            busyPeriods.push({
              start: new Date(slot.start_time * 1000).toISOString(),
              end: new Date(slot.end_time * 1000).toISOString(),
            });
          }
        }

        logger.trace("Nylas calendar busy periods", {
          busyPeriods,
          timeMin,
          timeMax,
        });

        return busyPeriods;
      } catch (error) {
        logger.error("Error fetching Nylas calendar busy periods", {
          error,
          ...getCalendarAvailabilityErrorLogContext(error),
        });
        throw error;
      }
    },
  };
}
