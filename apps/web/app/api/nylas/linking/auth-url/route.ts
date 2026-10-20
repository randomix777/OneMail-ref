import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import {
  getMailboxLinkingBlockedResponse,
  hasActiveAccountLinkingUser,
} from "@/utils/oauth/account-linking";
import { findReconnectTarget } from "@/utils/oauth/reconnect-target";
import { createOAuthLinkingAuditLogger } from "@/utils/oauth/linking-audit";
import {
  generateSignedOAuthState,
  oauthStateCookieOptions,
} from "@/utils/oauth/state";
import {
  buildNylasAuthUrl,
  NYLAS_LINKING_STATE_COOKIE_NAME,
} from "@/utils/nylas/auth";
import { hasNylasConfig } from "@/utils/nylas/client";
import { hasPaidMailboxSubscription } from "@/utils/email/paid-mailbox";

export type GetNylasAuthLinkUrlResponse = { url: string };

const getAuthUrl = ({
  userId,
  reconnectTarget,
}: {
  userId: string;
  reconnectTarget: { id: string; email: string } | null;
}) => {
  const stateNonce = randomUUID();

  const state = generateSignedOAuthState({
    userId,
    nonce: stateNonce,
    ...(reconnectTarget && { reconnectEmailAccountId: reconnectTarget.id }),
  });

  const url = buildNylasAuthUrl({
    state,
    // A reconnect targets one mailbox, so point Google at it rather than
    // letting whichever account the browser is signed into decide.
    ...(reconnectTarget && { loginHint: reconnectTarget.email }),
  });

  return { url, state, stateNonce };
};

export const GET = withAuth("nylas/linking/auth-url", async (request) => {
  const userId = request.auth.userId;

  const blockedResponse = getMailboxLinkingBlockedResponse(request);
  if (blockedResponse) return blockedResponse;

  if (!hasNylasConfig()) {
    // Google mail is reached only through Nylas, so an instance without Nylas
    // credentials has no Google connector to start. Say so plainly instead of
    // failing while building the URL.
    return NextResponse.json(
      {
        error: "Google mail requires Nylas to be configured on this instance.",
        isKnownError: true,
      },
      { status: 400 },
    );
  }

  const hasActiveUser = await hasActiveAccountLinkingUser({
    targetUserId: userId,
    logger: request.logger,
  });

  if (!hasActiveUser) {
    return NextResponse.json(
      { error: "Unauthorized", isKnownError: true, redirectTo: "/logout" },
      { status: 401 },
    );
  }

  if (!(await hasPaidMailboxSubscription({ userId }))) {
    // Google mail is the one family we pay a broker for, so it is the one
    // family a subscription covers. Connecting one without a subscription
    // would be a cost with no revenue behind it.
    return NextResponse.json(
      {
        error: "Google mail is billed per mailbox.",
        isKnownError: true,
        redirectTo: "/accounts?error=google_mail_requires_subscription",
      },
      { status: 403 },
    );
  }

  const reconnectEmailAccountId =
    request.nextUrl.searchParams.get("emailAccountId");
  const reconnectTarget = reconnectEmailAccountId
    ? await findReconnectTarget({
        emailAccountId: reconnectEmailAccountId,
        userId,
        // Google is the family this transport serves, so the reconnect target
        // is a Google mailbox however it is reached.
        provider: "google",
      })
    : null;

  // Falling back to an unconstrained link would reconnect whichever mailbox the
  // browser is signed into, which is the outcome the target exists to prevent.
  if (reconnectEmailAccountId && !reconnectTarget) {
    return NextResponse.json(
      { error: "Account not found", isKnownError: true },
      { status: 404 },
    );
  }

  const { url, state, stateNonce } = getAuthUrl({ userId, reconnectTarget });
  const logger = createOAuthLinkingAuditLogger({
    actorUserId: userId,
    logger: request.logger,
    provider: "google",
    stateNonce,
    targetUserId: userId,
  });

  logger.info("Nylas linking flow initiated");

  const response = NextResponse.json({ url });

  response.cookies.set(
    NYLAS_LINKING_STATE_COOKIE_NAME,
    state,
    oauthStateCookieOptions,
  );

  return response;
});
