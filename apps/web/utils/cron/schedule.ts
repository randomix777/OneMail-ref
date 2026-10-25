/**
 * The Vercel deployment runs `vercel.json`'s `crons` array. Cloudflare Workers
 * uses its own `triggers.crons`. A single every-minute trigger evaluates this
 * table and queues each due route for independent execution and retry.
 *
 * Keeping the schedule here (rather than in `wrangler.jsonc`) also keeps it
 * unit-testable: the matcher below is the only new logic, and it only has to
 * understand the syntax this table uses.
 */
export type ScheduledRoute = {
  path: string;
  /** A five-field cron expression in UTC. */
  schedule: string;
};

export const SCHEDULED_ROUTES: ScheduledRoute[] = [
  { path: "/api/cron/scheduled-actions", schedule: "* * * * *" },
  { path: "/api/watch/all", schedule: "0 * * * *" },
  { path: "/api/cron/imap-poll", schedule: "*/5 * * * *" },
  { path: "/api/resend/digest/all", schedule: "*/5 * * * *" },
  { path: "/api/resend/inbox-health/all", schedule: "0 8 * * *" },
  { path: "/api/resend/summary/all", schedule: "0 9 * * 1" },
  { path: "/api/meeting-briefs", schedule: "*/15 * * * *" },
  { path: "/api/meeting-recorder/schedule", schedule: "*/5 * * * *" },
  { path: "/api/follow-up-reminders", schedule: "0 * * * *" },
  { path: "/api/cron/automation-jobs", schedule: "*/15 * * * *" },
  { path: "/api/cron/reasoning-retention", schedule: "0 3 * * *" },
  { path: "/api/cron/mobile-push-retention", schedule: "30 3 * * *" },
  { path: "/api/cron/email-send-operation-retention", schedule: "45 3 * * *" },
  { path: "/api/cron/draft-cleanup", schedule: "0 4 * * *" },
];

type CronField = { any: true } | { any: false; values: number[] };

/**
 * Parses one cron field. Supports `*`, `*\/n`, and comma-separated numbers,
 * which is the whole syntax the schedule table above uses. Ranges (`1-5`) and
 * month/weekday names are deliberately rejected instead of silently
 * mis-parsed, so adding one of those to a schedule fails loudly in the test
 * suite rather than skipping a job in production.
 */
function parseField(field: string, min: number, max: number): CronField {
  if (field === "*") return { any: true };

  const stepMatch = /^\*\/(\d+)$/.exec(field);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (step < 1) throw new Error(`Invalid cron step: ${field}`);

    const values: number[] = [];
    for (let value = min; value <= max; value += step) values.push(value);
    return { any: false, values };
  }

  const values = field.split(",").map((part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid cron field: ${field}`);
    }
    return value;
  });

  return { any: false, values };
}

const CRON_FIELDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week, 0 = Sunday
] as const;

function matches(field: CronField, value: number): boolean {
  return field.any || field.values.includes(value);
}

/**
 * Returns true when `schedule` should run at `at`. Evaluated in UTC, matching
 * how Cloudflare Cron Triggers report `scheduledTime`.
 */
export function isScheduleDue(schedule: string, at: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== CRON_FIELDS.length) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  const fields = parts.map((part, index) => {
    const { min, max } = CRON_FIELDS[index];
    return parseField(part, min, max);
  });

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  return (
    matches(minute, at.getUTCMinutes()) &&
    matches(hour, at.getUTCHours()) &&
    matches(month, at.getUTCMonth() + 1) &&
    matchesDay(dayOfMonth, dayOfWeek, at)
  );
}

/**
 * Cron's day rule: a `*` in either day field defers to the other one, and when
 * both are restricted a match on either is enough.
 */
function matchesDay(
  dayOfMonth: CronField,
  dayOfWeek: CronField,
  at: Date,
): boolean {
  const dayOfMonthMatches = matches(dayOfMonth, at.getUTCDate());
  const dayOfWeekMatches = matches(dayOfWeek, at.getUTCDay());

  if (dayOfMonth.any && dayOfWeek.any) return true;
  if (dayOfMonth.any) return dayOfWeekMatches;
  if (dayOfWeek.any) return dayOfMonthMatches;

  return dayOfMonthMatches || dayOfWeekMatches;
}

export function scheduledRoutesDueAt(at: Date): ScheduledRoute[] {
  return SCHEDULED_ROUTES.filter((route) => isScheduleDue(route.schedule, at));
}
