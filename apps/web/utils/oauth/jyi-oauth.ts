import { env } from "@/env";

/** The provider id JYI's OAuth client is registered under. */
export const JYI_OAUTH_PROVIDER_ID = "jyi";

/**
 * Whether JYI's own OAuth provider is configured.
 *
 * When it is, the login page sends the user straight there: the sign-in
 * happens on JYI's own screen rather than on a third party's consent screen.
 */
export function isJyiOauthEnabled() {
  return Boolean(
    env.JYI_OAUTH_DISCOVERY_URL &&
      env.JYI_OAUTH_CLIENT_ID &&
      env.JYI_OAUTH_CLIENT_SECRET,
  );
}
