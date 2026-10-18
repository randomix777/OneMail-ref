import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  envMock,
  deferredWork,
  notifyMailboxChangedMock,
  getWebhookEmailAccountMock,
  validateWebhookAccountMock,
  processHistoryItemMock,
  createEmailProviderMock,
  markMessageAsProcessingMock,
} = vi.hoisted(() => ({
  envMock: {
    NYLAS_WEBHOOK_SECRET: "webhook-secret" as string | undefined,
  },
  deferredWork: [] as Promise<unknown>[],
  notifyMailboxChangedMock: vi.fn(),
  getWebhookEmailAccountMock: vi.fn(),
  validateWebhookAccountMock: vi.fn(),
  processHistoryItemMock: vi.fn(),
  createEmailProviderMock: vi.fn(),
  markMessageAsProcessingMock: vi.fn(),
}));

vi.mock("@/env", () => ({ env: envMock }));

/**
 * The route answers first and does the work in `after()`, so the assertions
 * have to wait for that deferred chain rather than for the response.
 */
vi.mock("next/server", async () => {
  const actual = await vi.importActual("next/server");

  return {
    ...actual,
    after: (task: () => unknown) => {
      const settled = Promise.resolve(task());
      deferredWork.push(settled);
      return settled;
    },
  };
});

vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithErrorTestMiddleware();
});

vi.mock("@/utils/mailbox-push", () => ({
  notifyMailboxChanged: (...args: unknown[]) =>
    notifyMailboxChangedMock(...args),
}));

vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  getWebhookEmailAccount: (...args: unknown[]) =>
    getWebhookEmailAccountMock(...args),
  validateWebhookAccount: (...args: unknown[]) =>
    validateWebhookAccountMock(...args),
}));

vi.mock("@/utils/webhook/process-history-item", () => ({
  processHistoryItem: (...args: unknown[]) => processHistoryItemMock(...args),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: (...args: unknown[]) => createEmailProviderMock(...args),
}));

vi.mock("@/utils/redis/message-processing", () => ({
  markMessageAsProcessing: (...args: unknown[]) =>
    markMessageAsProcessingMock(...args),
}));

import { GET, POST } from "./route";

const SECRET = "webhook-secret";
const GRANT_ID = "grant-1";

describe("Nylas webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deferredWork.length = 0;
    envMock.NYLAS_WEBHOOK_SECRET = SECRET;
    getWebhookEmailAccountMock.mockResolvedValue({
      id: "email-account-1",
      email: "owner@example.com",
      account: { provider: "google" },
    });
    validateWebhookAccountMock.mockResolvedValue({
      success: true,
      data: {
        emailAccount: { id: "email-account-1" },
        hasAutomationRules: true,
        hasAiAccess: true,
        rules: [],
      },
    });
    markMessageAsProcessingMock.mockResolvedValue(true);
    createEmailProviderMock.mockResolvedValue(getProvider());
    processHistoryItemMock.mockResolvedValue(undefined);
  });

  describe("endpoint verification", () => {
    it("echoes the challenge verbatim so Nylas can verify the endpoint", async () => {
      const response = await GET(
        new Request(
          "https://example.com/api/nylas/webhook?challenge=abc123-xyz",
        ) as never,
        {} as never,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      // Exactly the value: no quotes, no JSON envelope.
      expect(await response.text()).toBe("abc123-xyz");
    });

    it("rejects a verification request with no challenge", async () => {
      const response = await GET(
        new Request("https://example.com/api/nylas/webhook") as never,
        {} as never,
      );

      expect(response.status).toBe(400);
    });
  });

  describe("authentication", () => {
    it("fails closed when the webhook secret is missing", async () => {
      // An endpoint nobody can verify must not be able to drive automation.
      envMock.NYLAS_WEBHOOK_SECRET = undefined;
      const body = messageCreatedBody();

      const response = await POST(
        createRequest({ body }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(response.status).toBe(503);
      expect(processHistoryItemMock).not.toHaveBeenCalled();
      expect(notifyMailboxChangedMock).not.toHaveBeenCalled();
    });

    it("rejects a body altered after signing", async () => {
      const body = messageCreatedBody();
      const signature = sign(body);

      const response = await POST(
        createRequest({
          body: body.replace("msg-1", "msg-2"),
          signature,
        }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(response.status).toBe(401);
      expect(processHistoryItemMock).not.toHaveBeenCalled();
    });

    it("rejects a request with no signature at all", async () => {
      const response = await POST(
        createRequest({ body: messageCreatedBody(), signature: null }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(response.status).toBe(401);
    });

    it("rejects a payload it cannot route", async () => {
      const body = JSON.stringify({ type: "message.created", data: {} });

      const response = await POST(
        createRequest({ body, signature: sign(body) }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(response.status).toBe(400);
      expect(processHistoryItemMock).not.toHaveBeenCalled();
    });
  });

  describe("message notifications", () => {
    it("acknowledges immediately and processes the message", async () => {
      const response = await POST(
        createRequest({ body: messageCreatedBody() }) as never,
        {} as never,
      );

      // The response is not held open by the work.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await settleDeferredWork();

      // The local engine refreshes off this signal, before any premium gate.
      expect(notifyMailboxChangedMock).toHaveBeenCalledWith({
        emailAccountId: "email-account-1",
        logger: expect.anything(),
      });
      expect(processHistoryItemMock).toHaveBeenCalledWith(
        { messageId: "msg-1", threadId: "thread-1" },
        expect.objectContaining({ isNewMessage: true }),
      );
    });

    it("treats an update as an existing message", async () => {
      await POST(
        createRequest({ body: notificationBody("message.updated") }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(processHistoryItemMock).toHaveBeenCalledWith(
        { messageId: "msg-1", threadId: "thread-1" },
        expect.objectContaining({ isNewMessage: false }),
      );
    });

    it("skips a delivery that is already being processed", async () => {
      markMessageAsProcessingMock.mockResolvedValue(false);

      await POST(
        createRequest({ body: messageCreatedBody() }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(createEmailProviderMock).not.toHaveBeenCalled();
      expect(processHistoryItemMock).not.toHaveBeenCalled();
      // The engine still gets told, so a refresh is never lost to the lock.
      expect(notifyMailboxChangedMock).toHaveBeenCalledTimes(1);
    });

    it("ignores a grant that no longer belongs to an account", async () => {
      getWebhookEmailAccountMock.mockResolvedValue(null);

      const response = await POST(
        createRequest({ body: messageCreatedBody() }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(response.status).toBe(200);
      expect(notifyMailboxChangedMock).not.toHaveBeenCalled();
      expect(processHistoryItemMock).not.toHaveBeenCalled();
    });

    it("does not run rules when the account fails validation", async () => {
      validateWebhookAccountMock.mockResolvedValue({ success: false });

      await POST(
        createRequest({ body: messageCreatedBody() }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(createEmailProviderMock).not.toHaveBeenCalled();
      expect(processHistoryItemMock).not.toHaveBeenCalled();
    });

    it("ignores a message notification with no message id", async () => {
      const body = JSON.stringify({
        type: "message.created",
        data: { grant_id: GRANT_ID, object: { thread_id: "thread-1" } },
      });

      await POST(createRequest({ body, signature: sign(body) }) as never);
      await settleDeferredWork();

      expect(createEmailProviderMock).not.toHaveBeenCalled();
      expect(processHistoryItemMock).not.toHaveBeenCalled();
    });
  });

  describe("grant notifications", () => {
    it("refreshes the engine without running rules on a grant event", async () => {
      // A revoked grant is a reconnect prompt, not a mail event.
      await POST(
        createRequest({ body: notificationBody("grant.expired") }) as never,
        {} as never,
      );
      await settleDeferredWork();

      expect(notifyMailboxChangedMock).toHaveBeenCalledTimes(1);
      expect(validateWebhookAccountMock).not.toHaveBeenCalled();
      expect(processHistoryItemMock).not.toHaveBeenCalled();
    });
  });

  describe("truncated notifications", () => {
    it("reads the thread from the provider when the payload dropped it", async () => {
      // Nylas caps payloads at 1 MB and sends `*.truncated` with the body
      // dropped, so the thread it belongs to is not in the notification.
      createEmailProviderMock.mockResolvedValue(
        getProvider({ threadId: "thread-from-provider" }),
      );
      const body = truncatedBody("message.updated.truncated");

      await POST(createRequest({ body, signature: sign(body) }) as never);
      await settleDeferredWork();

      expect(processHistoryItemMock).toHaveBeenCalledWith(
        { messageId: "msg-1", threadId: "thread-from-provider" },
        expect.objectContaining({ isNewMessage: false }),
      );
    });

    it("falls back to the message id when the truncated message is gone", async () => {
      // `message.deleted.truncated` names a message that no longer exists, so
      // the re-fetch fails and there is nothing better to fall back to.
      createEmailProviderMock.mockResolvedValue(
        getProvider({ getMessageError: new Error("Message not found") }),
      );
      const body = truncatedBody("message.deleted.truncated");

      await POST(createRequest({ body, signature: sign(body) }) as never);
      await settleDeferredWork();

      expect(processHistoryItemMock).toHaveBeenCalledWith(
        { messageId: "msg-1", threadId: "msg-1" },
        expect.objectContaining({ isNewMessage: false }),
      );
    });

    it("does not spend a provider read when the payload kept the thread", async () => {
      const provider = getProvider();
      createEmailProviderMock.mockResolvedValue(provider);
      const body = notificationBody("message.updated.truncated");

      await POST(createRequest({ body, signature: sign(body) }) as never);
      await settleDeferredWork();

      expect(provider.getMessage).not.toHaveBeenCalled();
      expect(processHistoryItemMock).toHaveBeenCalledWith(
        { messageId: "msg-1", threadId: "thread-1" },
        expect.anything(),
      );
    });
  });

  async function settleDeferredWork() {
    await Promise.all(deferredWork.splice(0));
  }
});

function notificationBody(type: string) {
  return JSON.stringify({
    type,
    data: {
      grant_id: GRANT_ID,
      object: { id: "msg-1", thread_id: "thread-1" },
    },
  });
}

/** A truncated payload: the object arrives with its body dropped. */
function truncatedBody(type: string) {
  return JSON.stringify({
    type,
    data: { grant_id: GRANT_ID, object: { id: "msg-1" } },
  });
}

function messageCreatedBody() {
  return notificationBody("message.created");
}

function createRequest({
  body,
  signature = sign(body),
}: {
  body: string;
  signature?: string | null;
}) {
  return new Request("https://example.com/api/nylas/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-nylas-signature": signature } : {}),
    },
    body,
  });
}

function sign(rawBody: string) {
  return createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

function getProvider({
  threadId = "thread-1",
  getMessageError,
}: {
  threadId?: string;
  getMessageError?: Error;
} = {}) {
  return {
    name: "google",
    getMessage: vi.fn(async () => {
      if (getMessageError) throw getMessageError;
      return { id: "msg-1", threadId };
    }),
  };
}
