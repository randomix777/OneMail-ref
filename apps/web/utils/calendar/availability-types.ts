export type BusyPeriod = {
  start: string;
  end: string;
};

export interface CalendarAvailabilityProvider {
  /**
   * Fetch busy periods for the given calendars
   */
  fetchBusyPeriods(params: {
    accessToken?: string | null;
    connectionId?: string | null;
    refreshToken: string | null;
    expiresAt: number | null;
    emailAccountId: string;
    /** Set instead of tokens when the connection is reached through Nylas. */
    grantId?: string | null;
    /**
     * The connection's own calendar address. Nylas' free/busy is asked per
     * address rather than per calendar id.
     */
    email?: string | null;
    calendarIds: string[];
    timeMin: string;
    timeMax: string;
    failOnCalendarError?: boolean;
  }): Promise<BusyPeriod[]>;
  name: "google" | "microsoft" | "nylas";
}
