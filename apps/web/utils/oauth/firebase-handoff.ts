import { env } from "@/env";

/** The account-centre client id registered for OneMail's Firebase handoff. */
export const ONEMAIL_FIREBASE_CLIENT_ID = "onemail-web";

export function isFirebaseHandoffEnabled() {
  return Boolean(
    env.FIREBASE_HANDOFF_ENABLED === "true" &&
      env.FIREBASE_ACCOUNT_ORIGIN &&
      env.FIREBASE_CLIENT_SECRET_ONEMAIL,
  );
}

export function getFirebaseHandoffConfig() {
  if (!isFirebaseHandoffEnabled()) return null;

  const accountOrigin = env.FIREBASE_ACCOUNT_ORIGIN?.replace(/\/+$/, "");
  const baseUrl = env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const secret = env.FIREBASE_CLIENT_SECRET_ONEMAIL;
  if (!accountOrigin || !secret) return null;

  try {
    const account = new URL(accountOrigin);
    const own = new URL(baseUrl);
    if (
      (account.protocol !== "https:" && account.hostname !== "localhost") ||
      (own.protocol !== "https:" && own.hostname !== "localhost")
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    accountOrigin,
    baseUrl,
    clientId: env.FIREBASE_HANDOFF_CLIENT_ID || ONEMAIL_FIREBASE_CLIENT_ID,
    secret,
    redirectUri: `${baseUrl}/api/auth/firebase/callback`,
  };
}
