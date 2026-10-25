import { describe, expect, it, vi } from "vitest";
import {
  cloudflareRequestScope,
  dispatchCloudflareRequest,
  getCloudflareBindings,
} from "./context";

describe("Workers request resources", () => {
  it("fails queue delivery when a background task fails after returning HTTP 200", async () => {
    const pending: Promise<unknown>[] = [];
    const response = await dispatchCloudflareRequest(
      new Request("https://mail.example.com"),
      {},
      {
        waitUntil: (promise) => {
          pending.push(promise);
          promise.catch(() => {});
        },
      },
      async (_request, _bindings, context) => {
        context.waitUntil(
          Promise.resolve().then(() => {
            throw new Error("processing failed");
          }),
        );
        return new Response("accepted");
      },
      { queueDelivery: true },
    );
    await expect(response.text()).rejects.toThrow("processing failed");
    await Promise.allSettled(pending);
  });
  it("keeps resources open through streaming and background work", async () => {
    const cleanup = vi.fn();
    const pending: Promise<unknown>[] = [];
    let release = () => {};
    const background = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = await dispatchCloudflareRequest(
      new Request("https://mail.example.com"),
      {},
      {
        waitUntil: (promise) => {
          pending.push(promise);
        },
      },
      async (_request, _bindings, context) => {
        const scope = cloudflareRequestScope.getStore();
        if (!scope) throw new Error("Missing request scope");
        scope.cleanup.add(cleanup);
        context.waitUntil(background);
        return new Response("streamed response");
      },
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(await response.text()).toBe("streamed response");
    expect(cleanup).not.toHaveBeenCalled();
    release();
    await Promise.all(pending);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("isolates concurrent requests and closes resources when streaming fails", async () => {
    const pending: Promise<unknown>[] = [];
    const cleanup = vi.fn();
    const responses = await Promise.all(
      ["one", "two"].map((key) =>
        dispatchCloudflareRequest(
          new Request("https://mail.example.com"),
          { INTERNAL_API_KEY: key },
          {
            waitUntil: (promise) => {
              pending.push(promise);
            },
          },
          async () => {
            await Promise.resolve();
            expect(getCloudflareBindings()?.INTERNAL_API_KEY).toBe(key);
            cloudflareRequestScope.getStore()?.cleanup.add(cleanup);
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("stream failed"));
                },
              }),
            );
          },
        ),
      ),
    );
    await Promise.allSettled(responses.map((response) => response.text()));
    await Promise.all(pending);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(getCloudflareBindings()).toBeUndefined();
  });
});
