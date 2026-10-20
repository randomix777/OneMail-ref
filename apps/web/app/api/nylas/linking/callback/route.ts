import { after } from "next/server";
import { clearAccountDisconnectedErrorIfResolved } from "@/utils/error-messages";
import { auth } from "@/utils/auth";
import { hash } from "@/utils/hash";
import prisma from "@/utils/prisma";
import { withError } from "@/utils/middleware";
import { validateOAuthCallback } from "@/utils/oauth/callback-validation";
import { createAccountLinkingRedirect } from "@/utils/oauth/account-linking-redirect";
import { handleAccountLinking } from "@/utils/oauth/account-linking";
import { isReconnectTargetMismatch } from "@/utils/oauth/reconnect-target";
import {
  hashOAuthAuditIdentifier,
  logOAuthLinkingCallbackValidation,
} from "@/utils/oauth/linking-audit";
import { mergeAccount } from "@/utils/user/merge-account";
import { handleOAuthCallbackError } from "@/utils/oauth/error-handler";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { SafeError } from "@/utils/error";
import { ensureEmailAccountsWatched } from "@/utils/email/watch-manager";
import { ensureNylasCalendarConnections } from "@/utils/calendar/nylas-connection";
import {
  acquireOAuthCodeLock,
  clearOAuthCode,
  getOAuthCodeResult,
  setOAuthCodeResult,
} from "@/utils/redis/oauth-code";
import {
  exchangeNylasCodeForGrantId,
  getNylasGrant,
  NYLAS_LINKING_STATE_COOKIE_NAME,
} from "@/utils/nylas/auth";
import { deleteNylasGrantById } from "@/utils/email/revoke-connection";
import { hasPaidMailboxSubscription } from "@/utils/email/paid-mailbox";

export const GET = withError("nylas/linking/callback", async (request) => {
  const actorSession = await auth(request.headers);
  const actorUserId = actorSession?.user.id ?? null;
  let logger = request.logger.with({
    actorUserId,
    auditType: "oauth_linking",
    hasActorSession: !!actorUserId,
    provider: "google",
    transport: "nylas",
  });

  const searchParams = request.nextUrl.searchParams;
  const storedState = request.cookies.get(
    NYLAS_LINKING_STATE_COOKIE_NAME,
  )?.value;

  const validation = validateOAuthCallback({
    code: searchParams.get("code"),
    receivedState: searchParams.get("state"),
    storedState,
    stateCookieName: NYLAS_LINKING_STATE_COOKIE_NAME,
    logger,
  });

  if (!validation.success) {
    return validation.response;
  }

  const { targetUserId, code, stateNonce, reconnectEmailAccountId } =
    validation;
  logger = logOAuthLinkingCallbackValidation({
    actorUserId,
    logger,
    provider: "google",
    stateNonce,
    targetUserId,
  });

  if (!actorUserId || actorUserId !== targetUserId) {
    return createAccountLinkingRedirect({
      query: { error: "invalid_state" },
      stateCookieName: NYLAS_LINKING_STATE_COOKIE_NAME,
    });
  }

  const cachedResult = await getOAuthCodeResult(code);
  if (cachedResult) {
    logger.info("OAuth code already processed, returning cached result", {
      targetUserId,
    });
    return createAccountLinkingRedirect({
      query: cachedResult.params,
      stateCookieName: NYLAS_LINKING_STATE_COOKIE_NAME,
    });
  }

  const acquiredLock = await acquireOAuthCodeLock(code);
  if (!acquiredLock) {
    logger.info("OAuth code is being processed by another request", {
      targetUserId,
    });
    return createAccountLinkingRedirect({
      stateCookieName: NYLAS_LINKING_STATE_COOKIE_NAME,
    });
  }

  try {
    const grantId = await exchangeNylasCodeForGrantId(code);
    const grant = await getNylasGrant(grantId);

    // Nylas brokers other providers too; this transport exists to carry Google.
    if (grant.provider !== "google") {
      throw new SafeError("Nylas returned a grant for a different provider.");
    }

    if (!(await hasPaidMailboxSubscription({ userId: targetUserId }))) {
      // The subscription can lapse between the consent screen and this
      // callback. The grant is a cost from the moment it exists, so it goes
      // back before it starts costing.
      await deleteNylasGrantById({ grantId, logger });

      return createAccountLinkingRedirect({
        query: { error: "google_mail_requires_subscription" },
        stateCookieName: NYLAS_LINKING_STATE_COOKIE_NAME,
      });
    }

    const providerAccountId = grant.id;
    const providerEmail = grant.email;

    const existingAccount = await prisma.account.findUnique({
      where: {
        provider_providerAccountId: { provider: "google", providerAccountId },
      },
      select: {
        id: true,
        userId: true,
        user: { select: { name: true, email: true } },
        emailAccount: true,
      },
    });

    if (
      isReconnectTargetMismatch({
        reconnectEmailAccountId,
        matchedEmailAccountId: existingAccount?.emailAccount?.id,
      })
    ) {
      logger.warn("Reconnect authorized a different provider account", {
        targetUserId,
        reconnectEmailAccountId,
        matchedEmailAccountId: existingAccount?.emailAccount?.id ?? null,
      });
      return createAccountLinkingRedirect({
        query: { error: "reconnect_account_mismatch" },
        stateCookieName: NYLAS_LINKING_STATE_COOKIE_NAME,
      });
    }

    const linkingResult = await handleAccountLinking({
      existingAccountId: existingAccount?.id || null,
      hasEmailAccount: !!existingAccount?.emailAccount,
      existingUserId: existingAccount?.userId || null,
      targetUserId,
      provider: "google",
      providerEmail,
      logger,
    });

    if (linkingResult.type === "redirect") {
      linkingResult.response.cookies.delete(NYLAS_LINKING_STATE_COOKIE_NAME);
      return linkingResult.response;
    }

    if (
      linkingResult.type === "update_existing_account" ||
      linkingResult.type === "update_tokens"
    ) {
      await updateNylasAccount({
        accountId: linkingResult.existingAccountId,
        providerAccountId,
      });

      logger.info("OAuth linking callback completed", {
        accountId: linkingResult.existingAccountId,
        outcome: "grant_updated",
        providerEmailHash: hash(providerEmail),
        providerSubjectHash: hashOAuthAuditIdentifier(providerAccountId),
      });

      return completeNylasAccountLinking({
        code,
        logger,
        success: "tokens_updated",
        targetUserId,
      });
    }

    if (linkingResult.type === "merge") {
      const mergeType = await mergeAccount({
        sourceAccountId: linkingResult.sourceAccountId,
        sourceUserId: linkingResult.sourceUserId,
        targetUserId,
        email: providerEmail,
        name: existingAccount?.user.name || null,
        logger,
      });

      await updateNylasAccount({
        accountId: linkingResult.sourceAccountId,
        providerAccountId,
      });

      logger.info("OAuth linking callback completed", {
        outcome:
          mergeType === "full_merge"
            ? "account_merged"
            : "account_created_and_linked",
        providerEmailHash: hash(providerEmail),
        providerSubjectHash: hashOAuthAuditIdentifier(providerAccountId),
        sourceUserId: linkingResult.sourceUserId,
      });

      return completeNylasAccountLinking({
        code,
        logger,
        success:
          mergeType === "full_merge"
            ? "account_merged"
            : "account_created_and_linked",
        targetUserId,
      });
    }

    logger.info("Creating new Google account through Nylas", {
      email: providerEmail,
      targetUserId,
    });

    try {
      const newAccount = await prisma.account.create({
        data: {
          userId: targetUserId,
          type: "oidc",
          provider: "google",
          providerAccountId,
          // Nylas keeps the Google tokens; a grant id is all we store.
          transport: "nylas",
          emailAccount: {
            create: {
              email: providerEmail,
              userId: targetUserId,
            },
          },
        },
      });

      logger.info("OAuth linking callback completed", {
        accountId: newAccount.id,
        outcome: "account_created_and_linked",
        providerEmailHash: hash(providerEmail),
        providerSubjectHash: hashOAuthAuditIdentifier(providerAccountId),
      });
    } catch (createError: unknown) {
      if (!isDuplicateError(createError)) throw createError;

      // The grant already exists: Nylas keeps one grant per mailbox, so a
      // repeated link lands here instead of creating a second row.
      const accountNow = await prisma.account.findUnique({
        where: {
          provider_providerAccountId: { provider: "google", providerAccountId },
        },
        select: { id: true, userId: true },
      });

      if (!accountNow || accountNow.userId !== targetUserId) throw createError;

      logger.info("Account already linked, refreshing its grant", {
        accountId: accountNow.id,
        targetUserId,
      });

      await updateNylasAccount({
        accountId: accountNow.id,
        providerAccountId,
      });

      return completeNylasAccountLinking({
        code,
        logger,
        success: "tokens_updated",
        targetUserId,
      });
    }

    return completeNylasAccountLinking({
      code,
      logger,
      success: "account_created_and_linked",
      targetUserId,
    });
  } catch (error) {
    await clearOAuthCode(code);
    return handleOAuthCallbackError({
      error,
      stateCookieName: NYLAS_LINKING_STATE_COOKIE_NAME,
      logger,
    });
  }
});

/**
 * Records the grant on an account and clears everything that belonged to the
 * direct-Gmail transport: Google tokens Nylas now owns, the Pub/Sub watch, and
 * the Gmail history cursor.
 */
async function updateNylasAccount({
  accountId,
  providerAccountId,
}: {
  accountId: string;
  providerAccountId: string;
}) {
  await prisma.account.update({
    where: { id: accountId },
    data: {
      providerAccountId,
      transport: "nylas",
      disconnectedAt: null,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      scope: null,
      token_type: null,
      id_token: null,
    },
  });

  await prisma.emailAccount.updateMany({
    where: { accountId },
    data: {
      lastSyncedHistoryId: null,
      watchEmailsExpirationDate: null,
      watchEmailsSubscriptionId: null,
    },
  });
}

async function completeNylasAccountLinking({
  code,
  logger,
  success,
  targetUserId,
}: {
  code: string;
  logger: Parameters<typeof handleOAuthCallbackError>[0]["logger"];
  success: "account_created_and_linked" | "account_merged" | "tokens_updated";
  targetUserId: string;
}) {
  await setOAuthCodeResult(code, { success });

  after(() =>
    ensureEmailAccountsWatched({ userIds: [targetUserId], logger })
      .finally(() =>
        clearAccountDisconnectedErrorIfResolved({
          userId: targetUserId,
          logger,
        }),
      )
      .catch((error) => {
        logger.error(
          "Failed to re-register email watches after account linking",
          {
            error,
          },
        );
      }),
  );

  // Connecting a mailbox is also what connects its calendar, so this runs on its
  // own: a calendar that cannot be read must not affect the mail linking the
  // user is waiting on.
  after(() =>
    ensureNylasCalendarConnections({ userId: targetUserId, logger }).catch(
      (error) => {
        logger.error("Failed to connect calendars after account linking", {
          error,
        });
      },
    ),
  );

  return createAccountLinkingRedirect({
    query: { success },
    stateCookieName: NYLAS_LINKING_STATE_COOKIE_NAME,
  });
}
