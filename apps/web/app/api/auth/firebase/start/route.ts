import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import { getFirebaseHandoffConfig } from "@/utils/oauth/firebase-handoff";

const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export async function GET(request: Request) {
  const config = getFirebaseHandoffConfig();
  if (!config) return loginError("sign_in_not_configured");

  const url = new URL(request.url);
  const callbackURL = safeCallback(url.searchParams.get("callbackURL"));
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");

  try {
    await prisma.verification.create({
      data: {
        identifier: `onemail-firebase:${state}`,
        value: JSON.stringify({ verifier, callbackURL }),
        expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
      },
    });
  } catch {
    return loginError("sign_in_unavailable");
  }

  const target = new URL("/firebase-sign-in", config.accountOrigin);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", config.clientId);
  target.searchParams.set("redirect_uri", config.redirectUri);
  target.searchParams.set("scope", "openid profile email");
  target.searchParams.set("state", state);
  target.searchParams.set("code_challenge", codeChallenge);
  target.searchParams.set("code_challenge_method", "S256");
  const language = url.searchParams.get("lang");
  target.searchParams.set(
    "lang",
    language === "zh" || language === "fr" ? language : "en",
  );

  return new NextResponse(null, {
    status: 302,
    headers: {
      location: target.href,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
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

function safeCallback(value: string | null) {
  if (
    !value?.startsWith("/") ||
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
