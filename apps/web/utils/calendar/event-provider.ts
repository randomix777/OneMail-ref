import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import type { CalendarEventProvider } from "@/utils/calendar/event-types";
import { GoogleCalendarEventProvider } from "@/utils/calendar/providers/google-events";
import { MicrosoftCalendarEventProvider } from "@/utils/calendar/providers/microsoft-events";
import { NylasCalendarEventProvider } from "@/utils/calendar/providers/nylas-events";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";

/**
 * Create calendar event providers for all connected calendars.
 * Fetches calendar connections once and creates providers that can be reused.
 */
export async function createCalendarEventProviders(
  emailAccountId: string,
  logger: Logger,
): Promise<CalendarEventProvider[]> {
  const connections = await prisma.calendarConnection.findMany({
    where: {
      emailAccountId,
      isConnected: true,
    },
    select: {
      id: true,
      provider: true,
      transport: true,
      grantId: true,
      email: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
    },
  });

  if (connections.length === 0) {
    logger.info("No calendar connections found", { emailAccountId });
    return [];
  }

  const providers: CalendarEventProvider[] = [];

  for (const connection of connections) {
    if (!isUsableCalendarConnection(connection)) continue;

    try {
      providers.push(
        createCalendarEventProvider({ connection, emailAccountId, logger }),
      );
    } catch (error) {
      logger.error("Failed to create calendar event provider", {
        provider: connection.provider,
        error,
      });
    }
  }

  return providers;
}

// Same connections createCalendarEventProviders can use. A connection with no
// usable credential or an unknown provider builds no provider, so the chat tool
// would fail.
export async function hasUsableCalendarConnection(emailAccountId: string) {
  const connections = await prisma.calendarConnection.findMany({
    where: {
      emailAccountId,
      isConnected: true,
    },
    select: {
      provider: true,
      transport: true,
      grantId: true,
      refreshToken: true,
    },
  });

  return connections.some(isUsableCalendarConnection);
}

export function createCalendarEventProvider({
  connection,
  emailAccountId,
  logger,
}: {
  connection: {
    accessToken: string | null;
    expiresAt: Date | null;
    id: string;
    provider: string;
    refreshToken: string | null;
    transport?: string | null;
    grantId?: string | null;
    email?: string | null;
  };
  emailAccountId: string;
  logger: Logger;
}) {
  // The transport decides, not the family: a Google calendar reached through
  // Nylas has no tokens of ours, only a grant.
  if (connection.transport === "nylas") {
    if (!connection.grantId) {
      throw new SafeError("Nylas calendar connection has no grant.");
    }

    return new NylasCalendarEventProvider(
      {
        connectionId: connection.id,
        emailAccountId,
        grantId: connection.grantId,
        email: connection.email ?? "",
      },
      logger,
    );
  }

  const providerParams = {
    accessToken: connection.accessToken,
    connectionId: connection.id,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt?.getTime() ?? null,
    emailAccountId,
  };

  if (isGoogleProvider(connection.provider)) {
    return new GoogleCalendarEventProvider(providerParams, logger);
  }

  if (isMicrosoftProvider(connection.provider)) {
    return new MicrosoftCalendarEventProvider(providerParams, logger);
  }

  throw new SafeError("Unsupported calendar provider");
}

function isUsableCalendarConnection(connection: {
  provider: string;
  transport?: string | null;
  grantId?: string | null;
  refreshToken: string | null;
}) {
  // A Nylas connection holds a grant instead of a refresh token, so requiring a
  // token here would silently drop every Google calendar on that transport.
  if (connection.transport === "nylas") return !!connection.grantId;

  if (!connection.refreshToken) return false;

  return (
    isGoogleProvider(connection.provider) ||
    isMicrosoftProvider(connection.provider)
  );
}
