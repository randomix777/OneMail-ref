import { z } from "zod";
import type { CloudflareBindings } from "@/utils/cloudflare/context";

const jobSchema = z.object({
  method: z.enum(["GET", "POST"]),
  path: z.string(),
  body: z.unknown().optional(),
  rawBody: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  topic: z.string(),
});

export type CloudflareQueueBatch = {
  messages: readonly {
    id: string;
    body: unknown;
    attempts: number;
    ack(): void;
    retry(options?: { delaySeconds: number }): void;
  }[];
};

export async function consumeCloudflareJobs({
  batch,
  bindings,
  dispatch,
  report,
}: {
  batch: CloudflareQueueBatch;
  bindings: CloudflareBindings;
  dispatch(request: Request, verifiedWebhook: boolean): Promise<Response>;
  report(message: string, context: Record<string, unknown>): void;
}) {
  if (!bindings.NEXT_PUBLIC_BASE_URL) {
    throw new Error("Queue delivery requires NEXT_PUBLIC_BASE_URL");
  }
  const origin = new URL(bindings.NEXT_PUBLIC_BASE_URL);
  for (const message of batch.messages) {
    try {
      const job = jobSchema.parse(message.body);
      const url = new URL(job.path, origin);
      if (
        !job.path.startsWith("/api/") ||
        job.path.includes("\\") ||
        url.origin !== origin.origin ||
        !url.pathname.startsWith("/api/")
      ) {
        throw new Error("Queue jobs must target a local /api/ route");
      }
      if (!bindings.INTERNAL_API_KEY || !bindings.CRON_SECRET) {
        throw new Error(
          "Queue delivery requires INTERNAL_API_KEY and CRON_SECRET",
        );
      }
      const headers = new Headers(job.headers);
      headers.set("content-type", "application/json");
      headers.set("x-api-key", bindings.INTERNAL_API_KEY);
      headers.set("authorization", `Bearer ${bindings.CRON_SECRET}`);
      headers.set("x-onemail-job-id", message.id);
      const response = await dispatch(
        new Request(url, {
          method: job.method,
          headers,
          body:
            job.method === "POST"
              ? (job.rawBody ?? JSON.stringify(job.body ?? {}))
              : undefined,
          signal: AbortSignal.timeout(720_000),
        }),
        job.topic === "verified-webhook",
      );
      // Some cron routes execute their work while producing the response body.
      if (response.body) {
        await response.body.pipeTo(new WritableStream());
      }
      if (!response.ok)
        throw new Error(`Queue route returned ${response.status}`);
      message.ack();
    } catch (error) {
      report("Cloudflare job delivery failed", { jobId: message.id, error });
      // Mail webhook processing locks live for five minutes; retry after expiry.
      message.retry({
        delaySeconds: Math.min(
          3600,
          300 * 2 ** Math.max(0, message.attempts - 1),
        ),
      });
    }
  }
}
