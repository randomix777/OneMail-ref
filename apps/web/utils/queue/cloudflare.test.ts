import { describe, expect, it, vi } from "vitest";
import { cloudflareRequestScope } from "@/utils/cloudflare/context";
import { enqueueCloudflareJob, enqueueCloudflareWebhook } from "./cloudflare";

describe("Cloudflare queue publishing", () => {
  it("preserves signed webhook bytes without copying query credentials", async () => {
    const send = vi.fn(async () => {});
    const request = new Request(
      "https://mail.example.com/api/nylas/webhook?token=secret",
      {
        method: "POST",
        headers: { "x-nylas-signature": "signed", authorization: "secret" },
      },
    );
    await cloudflareRequestScope.run(
      { bindings: { JOBS: { send } }, cleanup: new Set() },
      () => enqueueCloudflareWebhook(request, '{ "id": "event-1" }'),
    );
    expect(send).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/nylas/webhook",
      rawBody: '{ "id": "event-1" }',
      headers: { "x-nylas-signature": "signed" },
      topic: "verified-webhook",
    });
    send.mockClear();
    await cloudflareRequestScope.run(
      { bindings: { JOBS: { send } }, cleanup: new Set(), queueDelivery: true },
      async () =>
        expect(await enqueueCloudflareWebhook(request, "{}")).toBe(false),
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("does not store delivery credentials in the queue", async () => {
    const send = vi.fn(async () => {});
    await cloudflareRequestScope.run(
      { bindings: { JOBS: { send } }, cleanup: new Set() },
      () =>
        enqueueCloudflareJob({
          path: "/api/automation-jobs/execute",
          body: { id: "run-1" },
          topic: "automation",
          headers: {
            authorization: "Bearer old",
            "x-api-key": "old",
            "x-email-account-id": "account-1",
          },
          delaySeconds: 2.1,
        }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { "x-email-account-id": "account-1" },
      }),
      { delaySeconds: 3 },
    );
  });

  it("fails instead of dropping work when the binding is missing", async () => {
    await expect(
      enqueueCloudflareJob({ path: "/api/task", body: {}, topic: "task" }),
    ).rejects.toThrow("JOBS");
  });

  it("rejects delays exceeding queue retention scheduling limits", async () => {
    const send = vi.fn(async () => {});
    await cloudflareRequestScope.run(
      { bindings: { JOBS: { send } }, cleanup: new Set() },
      async () => {
        await expect(
          enqueueCloudflareJob({
            path: "/api/task",
            body: {},
            topic: "task",
            delaySeconds: 43_201,
          }),
        ).rejects.toThrow("43200");
      },
    );
    expect(send).not.toHaveBeenCalled();
  });
});
