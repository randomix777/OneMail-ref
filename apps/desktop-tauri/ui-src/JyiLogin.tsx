import { useState } from "react";

import type { LocalSettingsSummary } from "./settings-types";

import type { InboxZeroDesktopApi } from "./desktop-api";

export function JyiLogin({
  settings,
  api,
  onConnected,
}: {
  settings: LocalSettingsSummary;
  api: InboxZeroDesktopApi;
  onConnected: (settings: LocalSettingsSummary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    setBusy(true);
    setError("");
    try {
      onConnected(await api.localAssistant.connectAi());
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The JYI sign-in could not be completed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="local-login">
      <section className="local-login-card">
        <p className="local-login-brand">OneMail</p>
        <h1>Sign in with JYI</h1>
        <p>
          OneMail uses JYI for AI analysis. Connect your JYI account to
          continue.
        </p>
        <button
          type="button"
          className="local-login-primary"
          disabled={busy}
          onClick={() => {
            connect();
          }}
        >
          {busy ? "Waiting for JYI sign-in…" : "Continue with JYI"}
        </button>
        {error ? (
          <p role="alert" className="local-error">
            {error}
          </p>
        ) : null}
        <p className="local-login-note">
          Your browser opens for JYI sign-in. Mailboxes and downloaded mail stay
          on this computer.
        </p>
        {settings.accounts.length ? (
          <p className="local-login-note">
            {settings.accounts.length === 1
              ? "1 mailbox is already connected."
              : `${settings.accounts.length} mailboxes are already connected.`}
          </p>
        ) : null}
      </section>
    </main>
  );
}
