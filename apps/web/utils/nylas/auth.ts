import { env } from "@/env";
import { SafeError } from "@/utils/error";
import { nylasFetch } from "@/utils/nylas/client";

export const NYLAS_LINKING_STATE_COOKIE_NAME = "nylas_linking_state";

export type NylasGrant = {
  id: string;
  email: string;
  provider: string;
};

export function getNylasLinkingRedirectUri() {
  return `${env.NEXT_PUBLIC_BASE_URL}/api/nylas/linking/callback`;
}

/**
 * Builds the Nylas Hosted Authentication URL.
 *
 * Nylas only brokers Google for us, so the provider is always pinned; that also
 * skips Nylas' provider picker. `access_type=online` is deliberate: Nylas stores
 * and refreshes the user's Google tokens itself and we call the API with our own
 * key, so there is no Nylas refresh token for us to hold.
 */
export function buildNylasAuthUrl({
  state,
  loginHint,
}: {
  state: string;
  loginHint?: string;
}) {
  const url = new URL(`${env.NYLAS_API_URI}/v3/connect/auth`);
  url.searchParams.set("client_id", requireNylasClientId());
  url.searchParams.set("redirect_uri", getNylasLinkingRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("provider", "google");
  url.searchParams.set("state", state);

  if (loginHint) url.searchParams.set("login_hint", loginHint);

  return url.toString();
}

/**
 * Exchanges the one-time code Nylas sent back for a grant id.
 *
 * The code is single-use: if this call fails the user has to start the flow
 * again rather than retrying the exchange.
 */
export async function exchangeNylasCodeForGrantId(code: string) {
  const response = await nylasFetch<{ grant_id?: string }>({
    path: "/connect/token",
    method: "POST",
    body: {
      client_id: requireNylasClientId(),
      // Nylas takes the application API key as the client secret.
      client_secret: env.NYLAS_API_KEY,
      grant_type: "authorization_code",
      code,
      redirect_uri: getNylasLinkingRedirectUri(),
    },
  });

  if (!response.grant_id) {
    throw new SafeError("Nylas did not return a grant for this account.");
  }

  return response.grant_id;
}

/**
 * Reads the mailbox identity Nylas attached to a grant. This is the authority
 * for which address we are linking, rather than a claim from the provider.
 */
export async function getNylasGrant(grantId: string): Promise<NylasGrant> {
  const response = await nylasFetch<{
    data?: { id?: string; email?: string; provider?: string };
  }>({ path: `/grants/${grantId}` });

  const grant = response.data;
  if (!grant?.id || !grant.email) {
    throw new SafeError("Nylas grant is missing its mailbox identity.");
  }

  return {
    id: grant.id,
    email: grant.email,
    provider: grant.provider ?? "",
  };
}

function requireNylasClientId() {
  const clientId = env.NYLAS_CLIENT_ID;
  if (!clientId) {
    throw new Error("NYLAS_CLIENT_ID is not configured");
  }
  return clientId;
}
