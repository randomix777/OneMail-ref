"use client";

import { useEffect, useState } from "react";
import { redirectToSafeUrl } from "@/utils/redirect";

/**
 * Sends the user through the JYI account centre's Firebase handoff.
 *
 * The account centre authenticates with Firebase and posts a one-time ticket
 * back to `/api/auth/firebase/callback`; the ticket is exchanged for a normal
 * OneMail session there. No provider token is placed in the URL.
 */
export function JyiOAuthRedirect({
  callbackURL,
  configured = true,
}: {
  callbackURL: string;
  /** Whether the instance has the account-centre handoff configured. */
  configured?: boolean;
}) {
  const [error] = useState<string | null>(
    configured ? null : "Sign-in is not configured on this instance.",
  );

  useEffect(() => {
    if (!configured) return;
    const params = new URLSearchParams({ callbackURL });
    redirectToSafeUrl(`/api/auth/firebase/start?${params.toString()}`);
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
