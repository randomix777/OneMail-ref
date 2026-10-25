import { describe, expect, it, vi } from "vitest";
import { consumeCloudflareJobs } from "./cloudflare-consumer";

const bindings = {
  NEXT_PUBLIC_BASE_URL: "https://mail.example.com",
  INTERNAL_API_KEY: "current-key",
  CRON_SECRET: "current-cron-key",
};

describe("Cloudflare job delivery", () => {
  it("authenticates internally and finishes streamed work before acknowledging", async () => {
    let completed = false;
    const ack = vi.fn(() => expect(completed).toBe(true));
    const retry = vi.fn();
    const dispatch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://mail.example.com/api/task");
      expect(request.headers.get("x-api-key")).toBe("current-key");
      expect(request.headers.get("authorization")).toBe(
        "Bearer current-cron-key",
      );
      expect(await request.json()).toEqual({ runId: "run-1" });
      return new Response(
        new ReadableStream({
          pull(controller) {
            completed = true;
            controller.close();
          },
        }),
      );
    });
    await consumeCloudflareJobs({
      batch: {
        messages: [
          {
            id: "job-1",
            attempts: 1,
            ack,
            retry,
            body: {
              method: "POST",
              path: "/api/task",
              body: { runId: "run-1" },
              topic: "task",
              headers: { "x-api-key": "stale-key" },
            },
          },
        ],
      },
      bindings,
      dispatch,
      report: vi.fn(),
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries failed jobs without redelivering successful messages", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null));
    await consumeCloudflareJobs({
      batch: {
        messages: ["a", "b"].map((id) => ({
          id,
          attempts: 1,
          ack,
          retry,
          body: { method: "GET", path: "/api/task", topic: "cron" },
        })),
      },
      bindings,
      dispatch,
      report: vi.fn(),
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });

  it.each([
    "https://outside.example/api/task",
    "/api/../../private",
    "/api/\\outside.example/task",
  ])("does not forward internal credentials to an invalid target: %s", async (path) => {
    const dispatch = vi.fn();
    const retry = vi.fn();
    await consumeCloudflareJobs({
      batch: {
        messages: [
          {
            id: "bad",
            attempts: 1,
            ack: vi.fn(),
            retry,
            body: {
              method: "GET",
              path,
              topic: "task",
            },
          },
        ],
      },
      bindings,
      dispatch,
      report: vi.fn(),
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });
});
