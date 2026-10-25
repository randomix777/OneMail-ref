import { useState } from "react";
import type { LocalSettingsSummary } from "./settings-types";
import type { InboxZeroDesktopApi } from "./desktop-api";
import { Dialog } from "./Dialog";
import { MailboxForm } from "./MailboxForm";

export function SettingsDialog({
  settings,
  api,
  onChange,
  onClose,
}: {
  settings: LocalSettingsSummary;
  api: InboxZeroDesktopApi;
  onChange: (settings: LocalSettingsSummary) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<LocalSettingsSummary>) {
    setBusy(true);
    setError("");
    try {
      onChange(await action());
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Settings could not be saved",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Local assistant settings" onClose={onClose}>
      <p>
        Your mailbox connects directly from this computer. Closing all windows
        stops mail processing.
      </p>
      {error ? (
        <p role="alert" className="local-error">
          {error}
        </p>
      ) : null}
      <section>
        <h3>Connected mailboxes</h3>
        {settings.accounts.length === 0 ? (
          <p>No mailbox connected.</p>
        ) : (
          settings.accounts.map((account) => (
            <div className="local-account-row" key={account.id}>
              <span>{account.email}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Disconnect ${account.email} and remove its local cache? Mail on the server will not be deleted.`,
                    )
                  )
                    run(() => api.localAssistant.removeAccount(account.id));
                }}
              >
                Disconnect
              </button>
            </div>
          ))
        )}
      </section>
      <section>
        <h3>Connect or reconnect a mailbox</h3>
        <p>
          Use your mail provider's app password where required. No OneMail
          mailbox subscription is needed.
        </p>
        <MailboxForm api={api} onSaved={onChange} />
      </section>
      <section>
        <h3>JYI AI</h3>
        <p>
          AI analysis sends the selected mail to JYI and uses your JYI token
          balance. JYI sign-in is required before the mailbox UI opens;
          disconnecting returns to the sign-in screen.
        </p>
        {settings.ai ? (
          <>
            <p>
              Account: {settings.ai.account_email ?? "Connected JYI account"}
            </p>
            <p>
              Available credits:{" "}
              {settings.ai.spendable_credits == null
                ? "Not available"
                : (settings.ai.spendable_credits / 1_000_000).toLocaleString()}
            </p>
            {settings.ai.allowance_syncing ? (
              <p>Your credits are still syncing. Refresh before analyzing.</p>
            ) : null}
            <div className="local-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  run(() => api.localAssistant.refreshAi());
                }}
              >
                Refresh balance
              </button>
              {settings.ai.topup_url ? (
                <a
                  href={settings.ai.topup_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Add credits
                </a>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  run(() => api.localAssistant.disconnectAi());
                }}
              >
                Disconnect JYI
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              run(() => api.localAssistant.connectAi());
            }}
          >
            {busy ? "Complete sign-in in your browser…" : "Connect JYI"}
          </button>
        )}
      </section>
    </Dialog>
  );
}
