import type { EmailProvider } from "@/utils/email/types";
import { isProviderFamily } from "@/utils/email/provider-registry";

export type EmailProviderRateLimitProvider = EmailProvider["name"];

type EmailProviderRateLimitMetadata = {
  apiErrorType: string;
  messageProviderLabel: string;
  bannerProviderLabel: string;
};

const EMAIL_PROVIDER_RATE_LIMIT_METADATA = {
  google: {
    apiErrorType: "Gmail Rate Limit Exceeded",
    messageProviderLabel: "Gmail",
    bannerProviderLabel: "Gmail",
  },
  microsoft: {
    apiErrorType: "Outlook Rate Limit",
    messageProviderLabel: "Microsoft",
    bannerProviderLabel: "Microsoft Outlook",
  },
  // The IMAP families do not report rate limits through an HTTP error type, so
  // `apiErrorType` exists only to keep this map total. Their labels are what the
  // user sees when a poll is backing off.
  yahoo: {
    apiErrorType: "Yahoo Mail Rate Limit",
    messageProviderLabel: "Yahoo Mail",
    bannerProviderLabel: "Yahoo Mail",
  },
  zoho: {
    apiErrorType: "Zoho Mail Rate Limit",
    messageProviderLabel: "Zoho Mail",
    bannerProviderLabel: "Zoho Mail",
  },
  fastmail: {
    apiErrorType: "Fastmail Rate Limit",
    messageProviderLabel: "Fastmail",
    bannerProviderLabel: "Fastmail",
  },
  icloud: {
    apiErrorType: "iCloud Mail Rate Limit",
    messageProviderLabel: "iCloud Mail",
    bannerProviderLabel: "iCloud Mail",
  },
  imap: {
    apiErrorType: "IMAP Rate Limit",
    messageProviderLabel: "this mail server",
    bannerProviderLabel: "Your mail server",
  },
} satisfies Record<
  EmailProviderRateLimitProvider,
  EmailProviderRateLimitMetadata
>;

export class ProviderRateLimitModeError extends Error {
  provider: EmailProviderRateLimitProvider;
  retryAt?: string;

  constructor({
    provider,
    retryAt,
  }: {
    provider: EmailProviderRateLimitProvider;
    retryAt?: Date;
  }) {
    const providerLabel = getProviderRateLimitMessageLabel(provider);
    const message = `${providerLabel} is temporarily rate limiting this account. Retry after ${retryAt?.toISOString()}.`;

    super(message);
    this.name = "ProviderRateLimitModeError";
    this.provider = provider;
    this.retryAt = retryAt?.toISOString();
  }
}

export function toRateLimitProvider(
  provider: string | null | undefined,
): EmailProviderRateLimitProvider | null {
  // Every family in the registry is readable, because `createEmailProvider`
  // gates on this and would otherwise reject a family it can actually build a
  // provider for.
  return typeof provider === "string" && isProviderFamily(provider)
    ? provider
    : null;
}

export function getProviderFromRateLimitApiErrorType(
  apiErrorType: string,
): EmailProviderRateLimitProvider | null {
  for (const [provider, metadata] of Object.entries(
    EMAIL_PROVIDER_RATE_LIMIT_METADATA,
  )) {
    if (metadata.apiErrorType === apiErrorType) {
      return provider as EmailProviderRateLimitProvider;
    }
  }
  return null;
}

export function getProviderRateLimitApiErrorType(
  provider: EmailProviderRateLimitProvider,
): string {
  return EMAIL_PROVIDER_RATE_LIMIT_METADATA[provider].apiErrorType;
}

export function getProviderRateLimitMessageLabel(
  provider: EmailProviderRateLimitProvider,
): string {
  return EMAIL_PROVIDER_RATE_LIMIT_METADATA[provider].messageProviderLabel;
}

export function getProviderRateLimitBannerLabel(
  provider: EmailProviderRateLimitProvider,
): string {
  return EMAIL_PROVIDER_RATE_LIMIT_METADATA[provider].bannerProviderLabel;
}

export function isProviderRateLimitModeError(
  error: unknown,
): error is ProviderRateLimitModeError {
  if (error instanceof ProviderRateLimitModeError) return true;
  if (typeof error !== "object" || error === null) return false;

  const maybeError = error as Record<string, unknown>;
  return (
    maybeError.name === "ProviderRateLimitModeError" &&
    toRateLimitProvider(maybeError.provider as string | null | undefined) !==
      null
  );
}
