import { env } from "@/env";
import { getCloudflareBindings } from "@/utils/cloudflare/context";

export type QueueBackend = "bullmq" | "internal" | "qstash" | "cloudflare";

export function getQueueBackend(): QueueBackend {
  if (getCloudflareBindings()) return "cloudflare";
  if (env.QUEUE_BACKEND) return env.QUEUE_BACKEND;
  if (env.QSTASH_TOKEN) return "qstash";
  return "internal";
}
