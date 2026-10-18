/**
 * Per-family facts about a mailbox provider: how we reach it and which
 * behaviours it can honour.
 *
 * A *family* is the account's identity (`Account.provider`) and drives copy,
 * feature availability, and error labels. A *transport* is how we actually talk
 * to the provider (`Account.transport`) and lives per account, because one
 * family can have more than one: Google mail goes through Nylas, while the
 * non-Google families use their own OAuth or IMAP.
 *
 * Capabilities exist because provider branches at call sites are usually asking
 * "can this provider do X?", not "is this Gmail?". Those call sites should ask
 * here instead. `isGoogleProvider`/`isMicrosoftProvider` stay family predicates
 * for genuinely family-specific behaviour and must not be widened to cover new
 * families.
 *
 * The capability set grows with each consumer; add a field when something reads
 * it rather than speculating about providers we have not built.
 */

export const PROVIDER_FAMILIES = ["google", "microsoft"] as const;

export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export type MailTransport = "oauth" | "nylas" | "imap";

export type ProviderCapabilities = {
  /**
   * Organizes mail with Gmail-style labels. False means folder/category
   * semantics, which changes user-facing copy.
   */
  labels: boolean;
  /** Has a star/flag that is independent of read state. */
  starred: boolean;
};

/**
 * Facts about a transport rather than a family, because one family can be
 * reached more than one way and these answers follow the way, not the identity.
 */
export type TransportCapabilities = {
  /**
   * New mail arrives on a per-mailbox subscription we have to create and renew
   * before it lapses. False means mail arrives without our involvement — an
   * application-wide webhook, or a poll we run ourselves.
   */
  perAccountWatch: boolean;
};

export type ProviderDefinition = {
  family: ProviderFamily;
  /** Human-readable name for copy and error messages. */
  label: string;
  /** Used when an account predates `Account.transport` or holds an unknown value. */
  defaultTransport: MailTransport;
  /** Server route that starts this family's mailbox connection. */
  linkingEndpoint: string;
  /** Page size the mail engine asks for when reading mailbox deltas. */
  syncPageSize: number;
  capabilities: ProviderCapabilities;
};

const PROVIDER_DEFINITIONS = {
  google: {
    family: "google",
    label: "Google",
    // Google mail goes through Nylas, which carries the CASA assessment we would
    // otherwise owe Google for restricted Gmail scopes.
    defaultTransport: "nylas",
    linkingEndpoint: "/api/nylas/linking/auth-url",
    syncPageSize: 50,
    capabilities: { labels: true, starred: true },
  },
  microsoft: {
    family: "microsoft",
    label: "Microsoft",
    defaultTransport: "oauth",
    linkingEndpoint: "/api/outlook/linking/auth-url",
    syncPageSize: 20,
    // Outlook organizes mail into folders/categories and has no star.
    capabilities: { labels: false, starred: false },
  },
} satisfies Record<ProviderFamily, ProviderDefinition>;

const TRANSPORT_CAPABILITIES = {
  // The provider holds a per-mailbox subscription (Gmail watch, Graph
  // subscription) that expires and has to be renewed.
  oauth: { perAccountWatch: true },
  // Nylas delivers every grant on one application-level webhook, so there is no
  // subscription to renew.
  nylas: { perAccountWatch: false },
  // IMAP has no push; new mail reaches the server through our own poll.
  imap: { perAccountWatch: false },
} satisfies Record<MailTransport, TransportCapabilities>;

export const MAIL_TRANSPORTS = ["oauth", "nylas", "imap"] as const;

export function isMailTransport(value: unknown): value is MailTransport {
  return (
    typeof value === "string" &&
    (MAIL_TRANSPORTS as readonly string[]).includes(value)
  );
}

export function isProviderFamily(provider: string): provider is ProviderFamily {
  return provider in PROVIDER_DEFINITIONS;
}

/**
 * The transport an account is really reached over. The stored value wins; a
 * missing or unrecognized one falls back to the family default so rows created
 * before `Account.transport` existed keep resolving to something usable.
 *
 * This is the only place that rule lives, because inferring a transport from a
 * provider anywhere else is how a Nylas-backed account ends up driven by a
 * direct client that holds no credentials for it.
 */
export function resolveMailTransport(
  provider: string,
  storedTransport: string | null | undefined,
): MailTransport {
  return isMailTransport(storedTransport)
    ? storedTransport
    : getProviderDefinition(provider).defaultTransport;
}

/** Whether the hourly watch job has a subscription to renew for this transport. */
export function usesPerAccountWatch(transport: MailTransport): boolean {
  return TRANSPORT_CAPABILITIES[transport].perAccountWatch;
}

/** Strict lookup for code paths that must reject a provider they cannot serve. */
export function getProviderDefinition(provider: string): ProviderDefinition {
  const definition = lookupProviderDefinition(provider);
  if (!definition) throw new Error(`Unsupported provider: ${provider}`);
  return definition;
}

/**
 * Capabilities for copy and feature-gating call sites. Unknown values keep the
 * historical Gmail-shaped default rather than throwing mid-render, because a
 * provider string reaching these call sites is unvalidated data, not a routing
 * decision. Providers we support are declared above, so the fallback only
 * applies to data we do not recognize.
 */
export function getProviderCapabilities(
  provider: string,
): ProviderCapabilities {
  return (
    lookupProviderDefinition(provider)?.capabilities ??
    DEFAULT_PROVIDER_CAPABILITIES
  );
}

export function getProviderSyncPageSize(provider: string): number {
  return (
    lookupProviderDefinition(provider)?.syncPageSize ??
    DEFAULT_PROVIDER_SYNC_PAGE_SIZE
  );
}

const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  labels: true,
  starred: true,
};

const DEFAULT_PROVIDER_SYNC_PAGE_SIZE = 50;

function lookupProviderDefinition(
  provider: string,
): ProviderDefinition | undefined {
  return (PROVIDER_DEFINITIONS as Record<string, ProviderDefinition>)[provider];
}
