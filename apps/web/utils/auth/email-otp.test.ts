import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSignature } from "better-auth/crypto";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  emailOtpAfterHook,
  emailOtpBeforeHook,
  emailOtpPlugin,
  emailOtpSessionCreationHook,
} from "@/utils/auth/email-otp";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

const email = "owner@example.com";

describe("disabled email code authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.deleteMany.mockResolvedValue({ count: 1 } as never);
  });

  it.each([
    "/email-otp/send-verification-otp",
    "/sign-in/email-otp",
    "/email-otp/verify-email",
    "/email-otp/reset-password",
    "/forget-password/email-otp",
  ])("rejects the legacy endpoint %s", async (path) => {
    const { request } = setup();

    const response = await request(path, {
      email,
      type: "sign-in",
      otp: "123456",
    });

    expect(response.status).toBe(403);
  });

  it("revokes an existing email-code session and clears its cookies", async () => {
    const { auth } = setup();
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(
      "owner",
      false,
      { emailOtp: true },
      true,
    );
    if (!session) throw new Error("No session");
    const cookie = `better-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, context.secret)}`)}`;

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(401);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { id: session.id, userId: "owner", emailOtp: true },
    });
    const clearedSessionCookie = response.headers
      .getSetCookie()
      .some(
        (value) =>
          value.includes("better-auth.session_token=") &&
          value.includes("Max-Age=0"),
      );
    expect(clearedSessionCookie).toBe(true);
  });
});

function setup() {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: "owner",
        email,
        name: "Owner",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-with-enough-entropy-for-email-otp",
    database: memoryAdapter(database),
    plugins: [emailOtpPlugin],
    hooks: {
      before: emailOtpBeforeHook,
      after: createAuthMiddleware(async (ctx) => {
        await emailOtpAfterHook(ctx);
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: emailOtpSessionCreationHook,
        },
      },
    },
    session: {
      additionalFields: {
        emailOtp: { type: "boolean", defaultValue: false, input: false },
        emailOtpVersion: { type: "number", defaultValue: 0, input: false },
      },
      cookieCache: { enabled: true },
    },
    rateLimit: { enabled: false },
  });
  const request = (path: string, body: Record<string, unknown>) =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      }),
    );

  return { auth, request };
}
