import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { followMailboxSignal } from "../../../desktop/src/mail-engine/mailbox-signals";
import { takeRecordedApnsSends } from "@/utils/apns";
import { createOutlookTestHarness, type OutlookTestHarness } from "./helpers";

const execute = promisify(execFile);
const REDIS_URL = "redis://127.0.0.1:36379";
const CONTAINER = "mailbox-change-push-redis";
const DEVICE_A = "a".repeat(64);
const DEVICE_B = "b".repeat(64);
const PUSH_ACCOUNT = "account-push";
const OUTLOOK_CREATED_ACCOUNT = "account-outlook-created";
const OUTLOOK_MOVED_ACCOUNT = "account-outlook-moved";
const NYLAS_EMAIL = "nylas-push@example.com";
const NYLAS_GRANT_ID = "grant-push";
const OUTLOOK_EMAIL = "outlook-push@example.com";

const redisState = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://127.0.0.1:36379";
  process.env.APNS_TRANSPORT = "fake";
  process.env.NYLAS_WEBHOOK_SECRET = "test-nylas-webhook-secret";
  process.env.MICROSOFT_WEBHOOK_CLIENT_STATE = "mailbox-push-state";
  return {
    client: null as import("ioredis").default | null,
  };
});

const accountLookup = vi.hoisted(() => ({
  getWebhookEmailAccount: vi.fn(),
}));

const pendingAfter = vi.hoisted(() => ({
  tasks: [] as Promise<unknown>[],
}));

vi.mock("next/server", async () => {
  const actual =
    await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (fn: () => void | Promise<void>) => {
      const task = Promise.resolve().then(() => fn());
      pendingAfter.tasks.push(task);
      return task;
    },
  };
});

vi.mock("@/utils/redis", () => ({
  redis: {
    exists: (key: string) => redisState.client!.exists(key),
    get: (key: string) => redisState.client!.get(key),
    del: (key: string) => redisState.client!.del(key),
    publish: (channel: string, message: string) =>
      redisState.client!.publish(channel, message),
    set: (
      key: string,
      value: string,
      options?: { nx?: boolean; ex?: number },
    ) => {
      const client = redisState.client!;
      if (options?.nx) {
        return client.set(key, value, "EX", options.ex ?? 1, "NX");
      }
      if (options?.ex) return client.set(key, value, "EX", options.ex);
      return client.set(key, value);
    },
  },
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      findUnique: vi.fn(async () => ({
        user: {
          mobilePushTokens: [{ token: DEVICE_A }, { token: DEVICE_B }],
        },
      })),
    },
    mobilePushToken: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  getWebhookEmailAccount: (...args: unknown[]) =>
    accountLookup.getWebhookEmailAccount(...args),
  cleanupWebhookAccountOnRateLimitSkip: vi.fn(),
  // These tests are about the push signal, which is sent before this gate. A
  // failing validation keeps the run off the provider and the rules pipeline.
  validateWebhookAccount: vi.fn(async () => ({ success: false })),
}));

vi.mock("@/utils/webhook/google/process-history", () => ({
  processHistoryForUser: vi.fn(async () => undefined),
}));

vi.mock("@/utils/webhook/outlook/process-history", () => ({
  processHistoryForUser: vi.fn(async () => undefined),
}));

vi.mock("@/utils/middleware", async () => {
  const actual =
    await vi.importActual<typeof import("@/utils/middleware")>(
      "@/utils/middleware",
    );
  const { createWithAuthTestMiddleware } = await import("@/__tests__/helpers");
  return { ...actual, ...createWithAuthTestMiddleware() };
});

import { POST as postNylasWebhook } from "@/app/api/nylas/webhook/route";
import { POST as postOutlookWebhook } from "@/app/api/outlook/webhook/route";
import { GET as getMailStream } from "@/app/api/mail-stream/route";

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "mailbox change push",
  { timeout: 60_000 },
  () => {
    let outlook: OutlookTestHarness;
    let createdMessageId = "";
    let movedMessageId = "";

    beforeAll(async () => {
      await execute("docker", ["rm", "--force", CONTAINER]).catch(
        () => undefined,
      );
      await execute("docker", [
        "run",
        "--detach",
        "--name",
        CONTAINER,
        "--publish",
        "36379:6379",
        "redis:7",
        "redis-server",
        "--save",
        "",
        "--appendonly",
        "no",
      ]);
      const Redis = (await import("ioredis")).default;
      redisState.client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
      await vi.waitFor(() => redisState.client!.ping());

      outlook = await createOutlookTestHarness({
        email: OUTLOOK_EMAIL,
        folders: [{ id: "archive", display_name: "Archive" }],
        messages: [
          {
            microsoft_id: "outlook-created",
            user_email: OUTLOOK_EMAIL,
            from: { address: "ada@example.com" },
            to_recipients: [{ address: OUTLOOK_EMAIL }],
            subject: "Created",
            body_content: "Hello",
            parent_folder_id: "inbox",
            is_read: false,
            received_date_time: "2026-09-28T12:00:00Z",
          },
          {
            microsoft_id: "outlook-moved",
            user_email: OUTLOOK_EMAIL,
            from: { address: "ada@example.com" },
            to_recipients: [{ address: OUTLOOK_EMAIL }],
            subject: "Move me",
            body_content: "Hello",
            parent_folder_id: "inbox",
            is_read: true,
            received_date_time: "2026-09-28T12:05:00Z",
          },
        ],
      });
      const listed = await outlook.graphClient.api("/me/messages").get();
      const created = listed.value.find(
        (message: { subject: string }) => message.subject === "Created",
      );
      const toMove = listed.value.find(
        (message: { subject: string; id: string }) =>
          message.subject === "Move me",
      );
      createdMessageId = created.id;
      const moved = await outlook.graphClient
        .api(`/me/messages/${toMove.id}/move`)
        .post({ destinationId: "archive" });
      movedMessageId = moved.id;
    });

    afterAll(async () => {
      await redisState.client?.quit();
      await execute("docker", ["rm", "--force", CONTAINER]).catch(
        () => undefined,
      );
      outlook?.restoreFetch();
      await outlook?.emulator.close();
    });

    beforeEach(async () => {
      takeRecordedApnsSends();
      pendingAfter.tasks.length = 0;
      await redisState.client?.flushdb();
      accountLookup.getWebhookEmailAccount.mockImplementation(
        async (query: { providerAccountId?: string }) => {
          if (query.providerAccountId === NYLAS_GRANT_ID)
            return { id: PUSH_ACCOUNT };
          if (query.watchEmailsSubscriptionId === "sub-created") {
            return { id: OUTLOOK_CREATED_ACCOUNT };
          }
          if (query.watchEmailsSubscriptionId === "sub-moved") {
            return { id: OUTLOOK_MOVED_ACCOUNT };
          }
          return null;
        },
      );
    });

    it("sends one silent push per device for a Nylas webhook and suppresses the next", async () => {
      const response = await postNylasWebhook(nylasWebhook());
      expect(response.status).toBe(200);
      await flushAfter();
      expect(
        await redisState.client!.exists(
          `mailbox-push-cooldown:${PUSH_ACCOUNT}`,
        ),
      ).toBe(1);

      expect(silentSends(PUSH_ACCOUNT)).toEqual([
        expect.objectContaining({ token: DEVICE_A, sandbox: true }),
        expect.objectContaining({ token: DEVICE_B, sandbox: true }),
      ]);

      const repeat = await postNylasWebhook(nylasWebhook());
      expect(repeat.status).toBe(200);
      await flushAfter();
      expect(
        await redisState.client!.exists(
          `mailbox-push-cooldown:${PUSH_ACCOUNT}`,
        ),
      ).toBe(1);
      expect(takeRecordedApnsSends()).toEqual([]);
    });

    it("sends one silent push per device for an Outlook create and a move", async () => {
      expect(createdMessageId).toBeTruthy();
      expect(movedMessageId).toBeTruthy();

      const created = await postOutlookWebhook(
        outlookWebhook("sub-created", "created", createdMessageId),
      );
      expect(created.status).toBe(200);
      await flushAfter();
      expect(silentSends(OUTLOOK_CREATED_ACCOUNT)).toHaveLength(2);

      const moved = await postOutlookWebhook(
        outlookWebhook("sub-moved", "updated", movedMessageId),
      );
      expect(moved.status).toBe(200);
      await flushAfter();
      expect(silentSends(OUTLOOK_MOVED_ACCOUNT)).toHaveLength(2);
    });

    it("delivers mailbox-change to the desktop client after a webhook", async () => {
      await redisState.client!.set(
        `account:user-1:${PUSH_ACCOUNT}`,
        NYLAS_EMAIL,
      );
      const changes: string[] = [];
      const abort = new AbortController();
      const following = followMailboxSignal({
        origin: "http://localhost",
        accountId: PUSH_ACCOUNT,
        cookieHeader: () => "",
        signal: abort.signal,
        onChange: () => {
          changes.push(PUSH_ACCOUNT);
        },
        fetchImpl: async (url, init) =>
          getMailStream(
            new NextRequest(url, {
              headers: init?.headers,
              signal: init?.signal ?? undefined,
            }),
          ),
      });

      try {
        await vi.waitFor(async () => {
          expect(
            await redisState.client!.exists(
              `local-mail-interest:${PUSH_ACCOUNT}`,
            ),
          ).toBe(1);
          // Connecting triggers a catch-up of its own.
          expect(changes).toEqual([PUSH_ACCOUNT]);
        });
        const response = await postNylasWebhook(nylasWebhook());
        expect(response.status).toBe(200);
        await flushAfter();
        await vi.waitFor(() =>
          expect(changes).toEqual([PUSH_ACCOUNT, PUSH_ACCOUNT]),
        );
      } finally {
        abort.abort();
        await following;
      }
    });
  },
);

function silentSends(emailAccountId: string) {
  return takeRecordedApnsSends().map((send) => {
    expect(send.payload).toEqual({
      aps: { "content-available": 1 },
      emailAccountId,
      hint: "mailbox",
    });
    return send;
  });
}

// The webhook must not await after(), so drain the queued callbacks here.
async function flushAfter() {
  while (pendingAfter.tasks.length > 0) {
    const batch = pendingAfter.tasks.splice(0, pendingAfter.tasks.length);
    await Promise.all(batch);
  }
}

function nylasWebhook() {
  const body = JSON.stringify({
    type: "message.created",
    data: {
      grant_id: NYLAS_GRANT_ID,
      object: { id: "nylas-push-message", thread_id: "thread-push" },
    },
  });
  const signature = createHmac("sha256", "test-nylas-webhook-secret")
    .update(body)
    .digest("hex");

  return new NextRequest("http://localhost/api/nylas/webhook", {
    method: "POST",
    headers: { "x-nylas-signature": signature },
    body,
  });
}

function outlookWebhook(
  subscriptionId: string,
  changeType: string,
  messageId: string,
) {
  return new NextRequest("http://localhost/api/outlook/webhook", {
    method: "POST",
    body: JSON.stringify({
      value: [
        {
          subscriptionId,
          clientState: "mailbox-push-state",
          changeType,
          resourceData: { id: messageId },
        },
      ],
    }),
  });
}
