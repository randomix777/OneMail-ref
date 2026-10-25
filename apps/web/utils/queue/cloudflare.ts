import {
  cloudflareRequestScope,
  getCloudflareBindings,
} from "@/utils/cloudflare/context";

export async function enqueueCloudflareJob({
  path,
  body,
  headers,
  topic,
  delaySeconds = 0,
}: {
  path: string;
  body: unknown;
  headers?: HeadersInit;
  topic: string;
  delaySeconds?: number;
}) {
  const queue = getCloudflareBindings()?.JOBS;
  if (!queue) throw new Error("Cloudflare JOBS queue binding is required");
  if (
    !Number.isFinite(delaySeconds) ||
    delaySeconds < 0 ||
    delaySeconds > 43_200
  ) {
    throw new Error(
      "Cloudflare queue delay must be between 0 and 43200 seconds",
    );
  }
  const forwardedHeaders = new Headers(headers);
  // Credentials are injected at delivery, so queued jobs survive key rotation.
  forwardedHeaders.delete("authorization");
  forwardedHeaders.delete("x-api-key");
  await queue.send(
    {
      method: "POST",
      path,
      body,
      topic,
      headers: Object.fromEntries(forwardedHeaders),
    },
    { delaySeconds: Math.ceil(delaySeconds) },
  );
}

export async function enqueueCloudflareWebhook(
  request: Request,
  rawBody: string,
) {
  const scope = cloudflareRequestScope.getStore();
  if (!scope || scope.queueDelivery) return false;
  const queue = scope.bindings.JOBS;
  if (!queue) throw new Error("Cloudflare JOBS queue binding is required");
  const headers: Record<string, string> = {};
  for (const name of ["stripe-signature", "x-nylas-signature"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  await queue.send({
    method: "POST",
    path: new URL(request.url).pathname,
    rawBody,
    headers,
    topic: "verified-webhook",
  });
  return true;
}
