import { useState, type FormEvent } from "react";
import type { LocalSettingsSummary } from "../local/settings";
import type { InboxZeroDesktopApi } from "./desktop-api";
import { Dialog } from "./Dialog";

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
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) ?? "");
    const saved = await run(() =>
      api.localAssistant.saveAccount({
        email: field("email").trim(),
        name: field("name"),
        username: field("username").trim(),
        password: field("password"),
        imap: {
          host: field("imapHost").trim(),
          port: Number(field("imapPort")),
          secure: field("imapSecure") === "tls",
        },
        smtp: {
          host: field("smtpHost").trim(),
          port: Number(field("smtpPort")),
          secure: field("smtpSecure") === "tls",
        },
      }),
    );
    if (saved) form.reset();
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
      <form
        onSubmit={(event) => {
          save(event);
        }}
      >
        <h3>Connect or reconnect a mailbox</h3>
        <p>
          Use your mail provider's app password where required. No OneMail
          mailbox subscription is needed.
        </p>
        <div className="local-form-grid">
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Display name
            <input name="name" autoComplete="name" />
          </label>
          <label>
            Mail server username
            <input name="username" required autoComplete="username" />
          </label>
          <label>
            Mail password or app password
            <input
              name="password"
              type="password"
              required
              autoComplete="off"
            />
          </label>
          <label>
            IMAP server
            <input name="imapHost" placeholder="imap.example.com" required />
          </label>
          <label>
            IMAP port
            <input
              name="imapPort"
              type="number"
              min="1"
              max="65535"
              defaultValue="993"
              required
            />
          </label>
          <label>
            IMAP encryption
            <select name="imapSecure" defaultValue="tls">
              <option value="tls">TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </label>
          <label>
            SMTP server
            <input name="smtpHost" placeholder="smtp.example.com" required />
          </label>
          <label>
            SMTP port
            <input
              name="smtpPort"
              type="number"
              min="1"
              max="65535"
              defaultValue="465"
              required
            />
          </label>
          <label>
            SMTP encryption
            <select name="smtpSecure" defaultValue="tls">
              <option value="tls">TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : "Verify and save mailbox"}
        </button>
      </form>
      <section>
        <h3>JYI AI</h3>
        <p>
          AI analysis sends the selected mail to JYI and uses your JYI token
          balance. Mail reading and sending work without signing in to JYI.
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
