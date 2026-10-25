import { useState, type FormEvent } from "react";

import type { InboxZeroDesktopApi } from "./desktop-api";
import { MAILBOX_PRESETS, presetById } from "./mailbox-presets";
import type { LocalSettingsSummary } from "./settings-types";

export function MailboxForm({
  api,
  onSaved,
  submitLabel = "Connect mailbox",
}: {
  api: InboxZeroDesktopApi;
  onSaved: (settings: LocalSettingsSummary) => void;
  submitLabel?: string;
}) {
  const [provider, setProvider] = useState("gmail");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preset = presetById(provider);
  const needsServers = provider === "other";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) ?? "");
    const email = field("email").trim();
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api.localAssistant.saveAccount({
          email,
          name: "",
          username: needsServers ? field("username").trim() || email : email,
          password: field("password"),
          imap: needsServers
            ? {
                host: field("imapHost").trim(),
                port: Number(field("imapPort")),
                secure: field("imapSecure") === "tls",
              }
            : preset.imap,
          smtp: needsServers
            ? {
                host: field("smtpHost").trim(),
                port: Number(field("smtpPort")),
                secure: field("smtpSecure") === "tls",
              }
            : preset.smtp,
        }),
      );
      form.reset();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The mailbox could not be connected",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        save(event);
      }}
    >
      {error ? (
        <p role="alert" className="local-error">
          {error}
        </p>
      ) : null}
      <label>
        Mail provider
        <select
          value={provider}
          disabled={busy}
          onChange={(event) => setProvider(event.target.value)}
        >
          {MAILBOX_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="local-form-grid">
        <label>
          Email address
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </label>
        <label>
          App password
          <input
            name="password"
            type="password"
            required
            autoComplete="off"
          />
        </label>
      </div>
      <p className="local-login-note">{preset.passwordHint}</p>
      {needsServers ? (
        <details className="local-advanced">
          <summary>Server settings</summary>
          <div className="local-form-grid">
            <label>
              Username
              <input
                name="username"
                autoComplete="username"
                placeholder="Defaults to your email address"
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
        </details>
      ) : null}
      <button type="submit" disabled={busy}>
        {busy ? "Checking with your mail server…" : submitLabel}
      </button>
    </form>
  );
}
