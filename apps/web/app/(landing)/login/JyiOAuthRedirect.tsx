"use client";

import { useEffect, useState } from "react";
import { JYI_OAUTH_PROVIDER_ID } from "@/utils/oauth/jyi-oauth";
import { redirectToSafeUrl } from "@/utils/redirect";

/**
 * Sends the user to JYI's own OAuth provider.
 *
 * JYI handles email/password sign-in and verified-email links for every
 * deployment, so all accounts use the same identity provider.
 */
export function JyiOAuthRedirect({
  callbackURL,
  configured = true,
}: {
  callbackURL: string;
  /** Whether the instance has JYI's OAuth provider configured. */
  configured?: boolean;
}) {
  const [error, setError] = useState<string | null>(
    configured ? null : "Sign-in is not configured on this instance.",
  );

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;

    async function start() {
      try {
        const response = await fetch("/api/auth/sign-in/oauth2", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: JYI_OAUTH_PROVIDER_ID,
            callbackURL,
          }),
        });
        const payload = (await response.json().catch(() => null)) as {
          url?: string;
          message?: string;
          error?: string;
        } | null;
        const url = payload?.url;

        if (!response.ok || !url) {
          throw new Error(
            payload?.message ??
              payload?.error ??
              "Could not reach the sign-in page",
          );
        }

        if (!cancelled) redirectToSafeUrl(url, { allowExternal: true });
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not reach the sign-in page",
        );
      }
    }

    start();

    return () => {
      cancelled = true;
    };
  }, [callbackURL, configured]);

  if (error) {
    return (
      <div className="px-4 text-center">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  }

  return (
    <p className="px-4 text-center text-sm text-muted-foreground">
      Taking you to the sign-in page...
    </p>
  );
}
