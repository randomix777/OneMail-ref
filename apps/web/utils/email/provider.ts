import {
  getGmailClientForEmail,
  getOutlookClientForEmail,
} from "@/utils/email-account-client";
import { getMailboxTransportContext } from "@/utils/email/account-transport";
import type { MailboxCredentialContext } from "@/utils/email/account-transport";
import { ImapMailProvider } from "@/utils/imap/provider";
import { GmailProvider } from "@/utils/email/google";
import { OutlookProvider } from "@/utils/email/microsoft";
import { NylasMailProvider } from "@/utils/email/nylas";
import {
  getProviderDefinition,
  type MailTransport,
  type ProviderFamily,
} from "@/utils/email/provider-registry";
import type { EmailProvider } from "@/utils/email/types";
import { assertProviderNotRateLimited } from "@/utils/email/rate-limit";
import { toRateLimitProvider } from "@/utils/email/rate-limit-mode-error";
import { recordEmailAccountProviderIssue } from "@/utils/email/provider-health";
import type { Logger } from "@/utils/logger";
import { flushLoggerSafely } from "@/utils/logger-flush";

export async function createEmailProvider({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
}): Promise<EmailProvider> {
  const rateLimitProvider = toRateLimitProvider(provider);
  if (!rateLimitProvider) throw new Error(`Unsupported provider: ${provider}`);

  try {
    await assertProviderNotRateLimited({
      emailAccountId,
      provider: rateLimitProvider,
      logger,
      source: "create-email-provider",
    });

    const { transport, providerAccountId, credential, email } =
      await getMailboxTransportContext({
        emailAccountId,
        provider: rateLimitProvider,
      });

    return withProviderFailureLogging(
      await createProviderForTransport({
        emailAccountId,
        provider: rateLimitProvider,
        transport,
        providerAccountId,
        credential,
        email,
        logger,
      }),
      { emailAccountId, provider: rateLimitProvider, logger },
    );
  } catch (error) {
    logger.warn("Failed to create email provider", {
      error,
      provider: rateLimitProvider,
      source: "create-email-provider",
    });
    await recordProviderIssueSafely({
      emailAccountId,
      provider: rateLimitProvider,
      error,
      logger,
      operation: "createEmailProvider",
    });
    await flushLoggerSafely(logger, {
      action: "createEmailProvider",
      flushReason: "provider-create-error",
      provider: rateLimitProvider,
    }).catch((loggingError) => {
      logger.warn("Failed to flush provider creation failure log", {
        error: loggingError,
        provider: rateLimitProvider,
        source: "create-email-provider",
      });
    });
    throw error;
  }
}

async function createProviderForTransport({
  emailAccountId,
  provider,
  transport,
  providerAccountId,
  credential,
  email,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  transport: MailTransport;
  providerAccountId: string | null;
  credential: MailboxCredentialContext | null;
  email: string | null;
  logger: Logger;
}): Promise<EmailProvider> {
  if (transport === "nylas") {
    if (!providerAccountId) {
      throw new Error(`Mailbox ${emailAccountId} has no Nylas grant id`);
    }
    return new NylasMailProvider({
      grantId: providerAccountId,
      emailAccountId,
      logger,
    });
  }

  if (transport === "imap") {
    if (!credential) {
      throw new Error(`Mailbox ${emailAccountId} has no IMAP credentials`);
    }
    if (!credential.active) {
      throw new Error(`Mailbox ${emailAccountId} has deactivated credentials`);
    }
    if (credential.secret === null) {
      throw new Error(`Mailbox ${emailAccountId} has no IMAP secret`);
    }

    const { family, label } = getProviderDefinition(provider);
    // The credential carries its own copy of the family so it can interpret its
    // provider's quirks; comparing them is what keeps the copy from drifting.
    if (credential.provider !== family) {
      throw new Error(
        `Mailbox ${emailAccountId} is ${family} but its credentials say ${credential.provider}`,
      );
    }

    if (!email) throw new Error(`Mailbox ${emailAccountId} has no address`);

    return new ImapMailProvider({
      family,
      emailAccountId,
      email,
      username: credential.username,
      secret: credential.secret,
      imapHost: credential.imapHost,
      imapPort: credential.imapPort,
      imapSecure: credential.imapSecure,
      smtpHost: credential.smtpHost,
      smtpPort: credential.smtpPort,
      smtpSecure: credential.smtpSecure,
      logger,
    });
  }

  if (transport !== "oauth") {
    // A mailbox cannot be talked to over a transport we have not built. Failing
    // here keeps a misconfigured or half-migrated account from silently falling
    // back to a client that would act on the wrong provider.
    throw new Error(`Unsupported transport for ${provider}: ${transport}`);
  }

  // Only the OAuth families have a client to build here. Every other family is
  // reached over a transport handled above, so reaching this point means the
  // stored transport and the family disagree — say so rather than falling
  // through to an Outlook-shaped default.
  const { family } = getProviderDefinition(provider);
  switch (family) {
    case "google": {
      const client = await getGmailClientForEmail({ emailAccountId, logger });
      return new GmailProvider(client, logger, emailAccountId);
    }
    case "microsoft": {
      const client = await getOutlookClientForEmail({ emailAccountId, logger });
      return new OutlookProvider(client, logger);
    }
    default:
      throw new Error(
        `${family} is not reached over the oauth transport (got ${transport})`,
      );
  }
}

function withProviderFailureLogging(
  emailProvider: EmailProvider,
  {
    emailAccountId,
    provider,
    logger,
  }: {
    emailAccountId: string;
    provider: ProviderFamily;
    logger: Logger;
  },
): EmailProvider {
  return new Proxy(emailProvider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      return (...args: unknown[]) => {
        let failedAccessToken: string | undefined;
        try {
          failedAccessToken = target.getAccessToken();
        } catch {
          // The operation may still refresh a missing cached access token.
        }
        try {
          const result = value.apply(target, args);
          if (!isPromiseLike(result)) return result;

          return result.catch(async (error: unknown) => {
            await logProviderOperationFailureSafely({
              error,
              failedAccessToken,
              emailAccountId,
              provider,
              logger,
              operation: String(property),
            });
            throw error;
          });
        } catch (error) {
          logProviderOperationFailureSafely({
            error,
            failedAccessToken,
            emailAccountId,
            provider,
            operation: String(property),
            logger,
          }).catch(() => undefined);
          throw error;
        }
      };
    },
  }) as EmailProvider;
}

async function logProviderOperationFailureSafely(
  input: ProviderOperationFailureLogInput,
) {
  try {
    await logProviderOperationFailure(input);
  } catch (loggingError) {
    input.logger.warn("Failed to log provider operation failure", {
      error: loggingError,
      emailAccountId: input.emailAccountId,
      provider: input.provider,
      operation: input.operation,
    });
  }
}

async function logProviderOperationFailure({
  error,
  emailAccountId,
  provider,
  logger,
  operation,
  failedAccessToken,
}: {
  error: unknown;
  emailAccountId: string;
  provider: ProviderFamily;
  logger: Logger;
  operation: string;
  failedAccessToken?: string;
}) {
  logger.warn("Email provider operation failed", {
    error,
    emailAccountId,
    provider,
    operation,
  });
  await recordProviderIssueSafely({
    emailAccountId,
    provider,
    error,
    logger,
    operation,
    failedAccessToken,
  });
  await flushLoggerSafely(logger, {
    action: "emailProvider",
    flushReason: "provider-operation-error",
    provider,
    operation,
  });
}

async function recordProviderIssueSafely({
  emailAccountId,
  provider,
  error,
  logger,
  operation,
  failedAccessToken,
}: ProviderOperationFailureLogInput) {
  await recordEmailAccountProviderIssue({
    emailAccountId,
    provider,
    error,
    logger,
    operation,
    failedAccessToken,
  }).catch((recordError) => {
    logger.warn("Failed to record provider issue", {
      error: recordError,
      emailAccountId,
      provider,
      operation,
    });
  });
}

type ProviderOperationFailureLogInput = {
  error: unknown;
  emailAccountId: string;
  provider: ProviderFamily;
  logger: Logger;
  operation: string;
  failedAccessToken?: string;
};

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function" &&
    "catch" in value &&
    typeof value.catch === "function"
  );
}
