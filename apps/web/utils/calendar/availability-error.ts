export type CalendarAvailabilityProviderName = "google" | "microsoft" | "nylas";

/**
 * The shape of one provider error inside an availability failure.
 *
 * Deliberately ours rather than Google's SDK type: Google fills `domain` and
 * `reason`, while Nylas reports a `message` per address, and a type that only
 * allowed Google's fields would force the Nylas path to drop its reason.
 */
export type CalendarAvailabilityProviderError = {
  // Google's SDK types these as `string | null`, so null has to be allowed or
  // its errors stop being assignable to this shape.
  domain?: string | null;
  reason?: string | null;
  message?: string | null;
};

export type CalendarAvailabilityErrorDetail = {
  calendarId: string;
  errors: CalendarAvailabilityProviderError[];
};

const PROVIDER_LABEL: Record<CalendarAvailabilityProviderName, string> = {
  google: "Google",
  microsoft: "Microsoft",
  nylas: "Nylas",
};

export class CalendarAvailabilityError extends Error {
  provider: CalendarAvailabilityProviderName;
  calendarErrors: CalendarAvailabilityErrorDetail[];

  constructor({
    provider,
    calendarErrors,
  }: {
    provider: CalendarAvailabilityProviderName;
    calendarErrors: CalendarAvailabilityErrorDetail[];
  }) {
    super(`Failed to fetch ${PROVIDER_LABEL[provider]} calendar availability`);
    this.name = "CalendarAvailabilityError";
    this.provider = provider;
    this.calendarErrors = calendarErrors;
  }
}

export function getCalendarAvailabilityErrorLogContext(error: unknown) {
  const calendarAvailabilityError = getCalendarAvailabilityError(error);
  if (!calendarAvailabilityError) return {};

  return {
    provider: calendarAvailabilityError.provider,
    calendarErrors: calendarAvailabilityError.calendarErrors.map(
      ({ calendarId, errors }) => ({
        calendarIdIsPrimary: calendarId === "primary",
        errors: errors.map((error) => ({
          domain: error.domain,
          reason: error.reason,
        })),
      }),
    ),
  };
}

function getCalendarAvailabilityError(
  error: unknown,
): CalendarAvailabilityError | undefined {
  if (typeof error !== "object" || error === null) return;

  const candidate = error as Partial<CalendarAvailabilityError>;
  if (
    candidate.name === "CalendarAvailabilityError" &&
    isCalendarAvailabilityProviderName(candidate.provider) &&
    Array.isArray(candidate.calendarErrors) &&
    candidate.calendarErrors.every(isCalendarAvailabilityErrorDetail)
  ) {
    return candidate as CalendarAvailabilityError;
  }
}

function isCalendarAvailabilityProviderName(
  value: unknown,
): value is CalendarAvailabilityProviderName {
  return value === "google" || value === "microsoft" || value === "nylas";
}

function isCalendarAvailabilityErrorDetail(
  value: unknown,
): value is CalendarAvailabilityErrorDetail {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Partial<CalendarAvailabilityErrorDetail>;
  return (
    typeof detail.calendarId === "string" &&
    Array.isArray(detail.errors) &&
    detail.errors.every(isCalendarAvailabilityProviderError)
  );
}

function isCalendarAvailabilityProviderError(
  value: unknown,
): value is CalendarAvailabilityProviderError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const error = value as CalendarAvailabilityProviderError;
  const isStringOrEmpty = (field: unknown) =>
    field === undefined || field === null || typeof field === "string";

  return (
    isStringOrEmpty(error.domain) &&
    isStringOrEmpty(error.reason) &&
    isStringOrEmpty(error.message)
  );
}
