"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { JYI_OAUTH_PROVIDER_ID } from "@/utils/oauth/jyi-oauth";
import { redirectToSafeUrl } from "@/utils/redirect";

/**
 * Sends the user to JYI's own OAuth provider.
 *
 * The sign-in happens on JYI's screen, so the app never drops the user on a
 * third party's consent page. The one-time code stays available as a way in
 * for anyone the provider cannot serve.
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
      <div className="space-y-3 px-4 text-center">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <p className="text-sm text-muted-foreground">
          <Link href="/login/email" className="underline underline-offset-4">
            Sign in with a one-time code instead
          </Link>
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
