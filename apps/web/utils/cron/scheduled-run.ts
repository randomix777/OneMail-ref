import { scheduledRoutesDueAt } from "./schedule";

/** The parts of a fetch response the runner needs; keeps the unit test small. */
type DispatchResponse = {
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
};

export type ScheduledRunOptions = {
  scheduledTime: Date;
  /** Matches what the cron routes check (`Authorization: Bearer …`). */
  secret: string | undefined;
  /** Only used to build an absolute URL; the request is handled in-process. */
  baseUrl: string;
  dispatch(request: Request): DispatchResponse | Promise<DispatchResponse>;
  report?(message: string, context: Record<string, unknown>): void;
};

export type ScheduledRunResult = {
  ran: string[];
  failed: string[];
};

/**
 * Runs every route that is due at `scheduledTime`.
 *
 * This direct runner replays the due routes from the schedule table. Each
 * route is dispatched through the Next server's own fetch handler so it keeps
 * the auth and behaviour it has when something calls it over HTTP.
 */
export async function runDueRoutes({
  scheduledTime,
  secret,
  baseUrl,
  dispatch,
  report,
}: ScheduledRunOptions): Promise<ScheduledRunResult> {
  const due = scheduledRoutesDueAt(scheduledTime);

  if (due.length === 0) {
    return { ran: [], failed: [] };
  }

  if (!secret) {
    report?.("No cron secret set, skipping scheduled work", {
      routes: due.map((route) => route.path),
    });
    return { ran: [], failed: due.map((route) => route.path) };
  }

  const ran: string[] = [];
  const failed: string[] = [];

  for (const route of due) {
    const request = new Request(new URL(route.path, baseUrl), {
      headers: { authorization: `Bearer ${secret}` },
    });

    try {
      const response = await dispatch(request);

      // Some routes perform their work while producing response chunks.
      if (response.body) await response.body.pipeTo(new WritableStream());

      if (response.ok) {
        ran.push(route.path);
        continue;
      }

      failed.push(route.path);
      report?.("Scheduled route failed", {
        path: route.path,
        status: response.status,
      });
    } catch (error) {
      // One failing route must not stop the rest of the minute's work.
      failed.push(route.path);
      report?.("Scheduled route threw", { path: route.path, error });
    }
  }

  return { ran, failed };
}
