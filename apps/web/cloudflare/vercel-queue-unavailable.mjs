export async function send() {
  throw new Error(
    "Vercel Queues is unavailable on Workers; use the JOBS binding",
  );
}

export function handleCallback() {
  return async () =>
    new Response("Queue callbacks are delivered through the JOBS binding", {
      status: 410,
    });
}
