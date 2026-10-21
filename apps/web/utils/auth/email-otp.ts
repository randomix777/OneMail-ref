import { APIError } from "better-auth";
import { deleteSessionCookie } from "better-auth/cookies";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import prisma from "@/utils/prisma";

const SIGN_IN_WITH_JYI_MESSAGE =
  "Sign in through your JYI account to continue.";

export const emailOtpPlugin = emailOTP({
  disableSignUp: true,
  storeOTP: "encrypted",
  expiresIn: 300,
  allowedAttempts: 5,
  rateLimit: { window: 60, max: 5 },
  async sendVerificationOTP() {
    throw jyiSignInRequiredError();
  },
});

export const emailOtpBeforeHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path?.includes("email-otp")) throw jyiSignInRequiredError();
  if (ctx.path === "/sign-out" || ctx.path === "/get-session") return;

  const current = await getSessionFromCtx(ctx);
  const session = current?.session as EmailOtpSession | undefined;
  if (!session?.emailOtp) return;

  await revokeEmailOtpSession(session);
  deleteSessionCookie(ctx);
  ctx.context.session = null;
  throw new APIError("UNAUTHORIZED", {
    message: "Session expired. Please sign in through your JYI account.",
  });
});

export async function emailOtpAfterHook(
  ctx: Parameters<typeof deleteSessionCookie>[0],
) {
  if (ctx.path !== "/get-session") return;
  const session = ctx.context.session?.session as EmailOtpSession | undefined;
  if (!session?.emailOtp) return;

  await revokeEmailOtpSession(session);
  deleteSessionCookie(ctx);
  ctx.context.session = null;
  throw new APIError("UNAUTHORIZED", {
    message: "Session expired. Please sign in through your JYI account.",
  });
}

type EmailOtpSession = {
  id: string;
  userId: string;
  emailOtp?: boolean;
};

export async function emailOtpSessionCreationHook<T extends { userId: string }>(
  _session: T,
  context?: { path?: string } | null,
) {
  if (context?.path === "/sign-in/email-otp") throw jyiSignInRequiredError();
}

async function revokeEmailOtpSession(session: EmailOtpSession) {
  await prisma.session.deleteMany({
    where: {
      id: session.id,
      userId: session.userId,
      emailOtp: true,
    },
  });
}

function jyiSignInRequiredError() {
  return new APIError("FORBIDDEN", {
    message: SIGN_IN_WITH_JYI_MESSAGE,
  });
}
