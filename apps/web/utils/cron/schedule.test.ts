import { describe, expect, it } from "vitest";
import {
  isScheduleDue,
  SCHEDULED_ROUTES,
  scheduledRoutesDueAt,
} from "./schedule";

describe("isScheduleDue", () => {
  it("matches every minute for * * * * *", () => {
    expect(isScheduleDue("* * * * *", new Date("2026-10-22T13:07:00Z"))).toBe(
      true,
    );
  });

  it("matches only the top of the hour for 0 * * * *", () => {
    expect(isScheduleDue("0 * * * *", new Date("2026-10-22T13:00:00Z"))).toBe(
      true,
    );
    expect(isScheduleDue("0 * * * *", new Date("2026-10-22T13:01:00Z"))).toBe(
      false,
    );
  });

  it("matches a five-minute step at :00, :05, :10 and not :03", () => {
    const schedule = "*/5 * * * *";
    expect(isScheduleDue(schedule, new Date("2026-10-22T13:00:00Z"))).toBe(
      true,
    );
    expect(isScheduleDue(schedule, new Date("2026-10-22T13:05:00Z"))).toBe(
      true,
    );
    expect(isScheduleDue(schedule, new Date("2026-10-22T13:10:00Z"))).toBe(
      true,
    );
    expect(isScheduleDue(schedule, new Date("2026-10-22T13:03:00Z"))).toBe(
      false,
    );
  });

  it("matches a fifteen-minute step at :30 but not :40", () => {
    expect(
      isScheduleDue("*/15 * * * *", new Date("2026-10-22T13:30:00Z")),
    ).toBe(true);
    expect(
      isScheduleDue("*/15 * * * *", new Date("2026-10-22T13:40:00Z")),
    ).toBe(false);
  });

  it("honours an hour and minute pair", () => {
    expect(isScheduleDue("30 3 * * *", new Date("2026-10-22T03:30:00Z"))).toBe(
      true,
    );
    expect(isScheduleDue("30 3 * * *", new Date("2026-10-22T03:31:00Z"))).toBe(
      false,
    );
    expect(isScheduleDue("30 3 * * *", new Date("2026-10-22T04:30:00Z"))).toBe(
      false,
    );
  });

  it("evaluates the weekday in UTC", () => {
    // 2026-10-26 is a Monday.
    expect(isScheduleDue("0 9 * * 1", new Date("2026-10-26T09:00:00Z"))).toBe(
      true,
    );
    expect(isScheduleDue("0 9 * * 1", new Date("2026-10-27T09:00:00Z"))).toBe(
      false,
    );
    // 09:00 UTC is 05:00 in America/Toronto, so a local-time reading would
    // place this on the previous day and miss the Monday slot.
    expect(isScheduleDue("0 9 * * 1", new Date("2026-10-26T04:00:00Z"))).toBe(
      false,
    );
  });

  it("rejects syntax it does not implement instead of guessing", () => {
    expect(() => isScheduleDue("0 9 * * 1-5", new Date())).toThrow(
      /Invalid cron field/,
    );
    expect(() => isScheduleDue("0 9 * *", new Date())).toThrow(
      /Invalid cron expression/,
    );
    expect(() => isScheduleDue("60 * * * *", new Date())).toThrow(
      /Invalid cron field/,
    );
  });
});

describe("scheduledRoutesDueAt", () => {
  it("returns every every-minute job at the top of the hour", () => {
    const paths = scheduledRoutesDueAt(new Date("2026-10-22T13:00:00Z")).map(
      (route) => route.path,
    );

    expect(paths).toContain("/api/cron/scheduled-actions");
    expect(paths).toContain("/api/watch/all");
    expect(paths).toContain("/api/cron/imap-poll");
    expect(paths).toContain("/api/follow-up-reminders");
  });

  it("returns only the every-minute job at an otherwise idle minute", () => {
    const paths = scheduledRoutesDueAt(new Date("2026-10-22T13:01:00Z")).map(
      (route) => route.path,
    );

    expect(paths).toEqual(["/api/cron/scheduled-actions"]);
  });

  it("returns nothing when no schedule lands on the minute", () => {
    // 03:07 UTC: not a 15-minute mark, not 08:00, not 09:00 Monday, not 04:00.
    const due = scheduledRoutesDueAt(new Date("2026-10-22T03:07:00Z")).filter(
      (route) => route.path !== "/api/cron/scheduled-actions",
    );

    expect(due).toEqual([]);
  });

  it("declares every route with a schedule the matcher understands", () => {
    for (const route of SCHEDULED_ROUTES) {
      expect(() => isScheduleDue(route.schedule, new Date())).not.toThrow();
    }
  });

  it("keeps the imap poll on the every-five-minutes schedule", () => {
    const route = SCHEDULED_ROUTES.find(
      (candidate) => candidate.path === "/api/cron/imap-poll",
    );

    expect(route?.schedule).toBe("*/5 * * * *");
  });
});
