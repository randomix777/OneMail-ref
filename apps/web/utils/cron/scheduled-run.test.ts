import { describe, expect, it, vi } from "vitest";
import { runDueRoutes } from "./scheduled-run";
import { scheduledRoutesDueAt } from "./schedule";

// 13:00 UTC — the minute where the hourly and the five-minute jobs overlap.
const TOP_OF_HOUR = new Date("2026-10-22T13:00:00Z");

function response(status = 200, complete = vi.fn()) {
  return new Response(
    new ReadableStream({
      pull(controller) {
        complete();
        controller.close();
      },
    }),
    { status },
  );
}

describe("runDueRoutes", () => {
  it("dispatches every due route with the cron secret", async () => {
    const dispatch = vi.fn(async (_request: Request) => response());

    const result = await runDueRoutes({
      baseUrl: "https://cron.onemail.invalid",
      dispatch,
      scheduledTime: TOP_OF_HOUR,
      secret: "s3cret",
    });

    const expected = scheduledRoutesDueAt(TOP_OF_HOUR).map((r) => r.path);
    expect(result).toEqual({ failed: [], ran: expected });
    expect(dispatch).toHaveBeenCalledTimes(expected.length);

    for (const [index, [request]] of dispatch.mock.calls.entries()) {
      expect(new URL(request.url).pathname).toBe(expected[index]);
      expect(request.headers.get("authorization")).toBe("Bearer s3cret");
    }
  });

  it("runs only the jobs due at an off-hour minute", async () => {
    const dispatch = vi.fn(async () => response());
    // 03:20 UTC: the daily jobs are behind, so only the every-minute and
    // five-minute jobs fire.
    const scheduledTime = new Date("2026-10-22T03:20:00Z");
    const expected = scheduledRoutesDueAt(scheduledTime).map((r) => r.path);

    const result = await runDueRoutes({
      baseUrl: "https://cron.onemail.invalid",
      dispatch,
      scheduledTime,
      secret: "s3cret",
    });

    expect(result.failed).toEqual([]);
    expect(result.ran).toEqual(expected);
    expect(expected).toContain("/api/cron/imap-poll");
    expect(expected).not.toContain("/api/cron/reasoning-retention");
  });

  it("reports and skips when the secret is missing", async () => {
    const dispatch = vi.fn(async () => response());
    const report = vi.fn();

    const result = await runDueRoutes({
      baseUrl: "https://cron.onemail.invalid",
      dispatch,
      report,
      scheduledTime: TOP_OF_HOUR,
      secret: undefined,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.ran).toEqual([]);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(report).toHaveBeenCalledWith(
      "No cron secret set, skipping scheduled work",
      expect.objectContaining({ routes: expect.any(Array) }),
    );
  });

  it("keeps going after a failed and a thrown route", async () => {
    const completed = vi.fn(async () => undefined);
    const report = vi.fn();
    const expected = scheduledRoutesDueAt(TOP_OF_HOUR).map((r) => r.path);
    let call = 0;

    const dispatch = vi.fn(async () => {
      call += 1;
      if (call === 1) return response(500);
      if (call === 2) throw new Error("network down");
      return response(200, completed);
    });

    const result = await runDueRoutes({
      baseUrl: "https://cron.onemail.invalid",
      dispatch,
      report,
      scheduledTime: TOP_OF_HOUR,
      secret: "s3cret",
    });

    expect(result.failed).toEqual(expected.slice(0, 2));
    expect(result.ran).toEqual(expected.slice(2));
    expect(report).toHaveBeenCalledWith(
      "Scheduled route failed",
      expect.objectContaining({ status: 500 }),
    );
    expect(report).toHaveBeenCalledWith(
      "Scheduled route threw",
      expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(completed).toHaveBeenCalledTimes(expected.length - 2);
  });

  it("drains the body of a failed route as well", async () => {
    const complete = vi.fn();
    await runDueRoutes({
      baseUrl: "https://cron.onemail.invalid",
      dispatch: async () => response(503, complete),
      scheduledTime: TOP_OF_HOUR,
      secret: "s3cret",
    });

    expect(complete).toHaveBeenCalledTimes(
      scheduledRoutesDueAt(TOP_OF_HOUR).length,
    );
  });
});
