import { NextResponse } from "next/server";
import { env } from "@/env";
import { betterAuthConfig } from "@/utils/auth";
import { getFirebaseHandoffConfig } from "@/utils/oauth/firebase-handoff";
import prisma from "@/utils/prisma";
import { buildMobileSessionCookie } from "@/utils/mobile-auth/session-cookie";

const MAX_CALLBACK_BYTES = 4096;

export async function POST(request: Request) {
  const config = getFirebaseHandoffConfig();
  if (!config) return loginError("sign_in_not_configured");

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return loginError("form_required");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return loginError("invalid_request");
  }
  const state = form.get("state");
  const ticket = form.get("ticket");
  if (
    typeof state !== "string" ||
    typeof ticket !== "string" ||
    !state ||
    !ticket ||
    form.getAll("state").length !== 1 ||
    form.getAll("ticket").length !== 1 ||
    ticket.length > MAX_CALLBACK_BYTES
  ) {
    return loginError("invalid_state");
  }

  let attempt: { id: string; value: string } | null;
  try {
    attempt = await prisma.verification.findFirst({
      where: {
        identifier: `onemail-firebase:${state}`,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, value: true },
    });
  } catch {
    return loginError("sign_in_unavailable");
  }
  if (!attempt) return loginError("invalid_state");

  let verifier: string;
  let callbackURL: string;
  try {
    const parsed = JSON.parse(attempt.value) as {
      verifier?: unknown;
      callbackURL?: unknown;
    };
    if (
      typeof parsed.verifier !== "string" ||
      typeof parsed.callbackURL !== "string"
    ) {
      return loginError("invalid_state");
    }
    verifier = parsed.verifier;
    callbackURL = safeCallback(parsed.callbackURL);
  } catch {
    return loginError("invalid_state");
  }

  await prisma.verification
    .delete({ where: { id: attempt.id } })
    .catch(() => undefined);

  let identity: {
    userId: string;
    emailVerified: boolean;
    accountEmail?: string | null;
    accountName?: string | null;
    accountEmailVerified?: boolean | null;
  };
  try {
    const response = await fetch(
      `${config.accountOrigin}/api/account/firebase/redeem`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          ticket,
          state,
          verifier,
          includeAccountProfile: true,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return loginError("ticket_rejected");
    const body = (await response.json()) as Record<string, unknown>;
    if (
      typeof body.userId !== "string" ||
      body.emailVerified !== true ||
      typeof body.accountEmail !== "string" ||
      !body.accountEmail
    ) {
      return loginError("ticket_rejected");
    }
    if (body.accountEmailVerified === false)
      return loginError("email_unverified");
    identity = {
      userId: body.userId,
      emailVerified: true,
      accountEmail: body.accountEmail,
      accountName:
        typeof body.accountName === "string" ? body.accountName : null,
      accountEmailVerified:
        typeof body.accountEmailVerified === "boolean"
          ? body.accountEmailVerified
          : null,
    };
  } catch {
    return loginError("ticket_unreachable");
  }

  const authContext = await betterAuthConfig.$context;
  const email = identity.accountEmail!.trim().toLowerCase();
  const name =
    identity.accountName?.trim().slice(0, 100) ||
    email.split("@")[0] ||
    "OneMail";

  let userId: string;
  try {
    const existing = await authContext.internalAdapter.findUserByEmail(email, {
      includeAccounts: true,
    });
    if (existing) {
      const linked = existing.accounts.find(
        (account) => account.providerId === "jyi",
      );
      if (linked && linked.accountId !== identity.userId) {
        return loginError("account_conflict");
      }
      if (!linked) {
        await authContext.internalAdapter.linkAccount({
          userId: existing.user.id,
          providerId: "jyi",
          accountId: identity.userId,
        });
      }
      userId = existing.user.id;
    } else {
      const created = await authContext.internalAdapter.createUser(
        {
          email,
          name,
          emailVerified: true,
        },
        {
          method: "oauth",
          oauth: {
            providerId: "jyi",
            profile: {
              sub: identity.userId,
              email,
              email_verified: true,
            },
          },
        },
      );
      await authContext.internalAdapter.createAccount({
        userId: created.id,
        providerId: "jyi",
        accountId: identity.userId,
      });
      userId = created.id;
    }
  } catch {
    return loginError("account_unavailable");
  }

  const session = await authContext.internalAdapter.createSession(
    userId,
    false,
    {},
  );
  if (!session?.token || !session.expiresAt) {
    return loginError("session_unavailable");
  }

  const cookie = await buildMobileSessionCookie({
    authContext,
    expiresAt: session.expiresAt,
    sessionToken: session.token,
  });

  const response = NextResponse.redirect(
    new URL(callbackURL, env.NEXT_PUBLIC_BASE_URL),
    303,
  );
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

function loginError(code: string) {
  const target = new URL("/login", env.NEXT_PUBLIC_BASE_URL);
  target.searchParams.set("error", code);
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: target.href,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function safeCallback(value: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/welcome-redirect";
  }
  try {
    const url = new URL(value, "https://onemail.invalid");
    if (url.origin !== "https://onemail.invalid") return "/welcome-redirect";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/welcome-redirect";
  }
}
