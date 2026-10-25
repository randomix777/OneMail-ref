import type { InboxZeroDesktopApi } from "./desktop-api";
import { MailboxForm } from "./MailboxForm";
import type { LocalSettingsSummary } from "./settings-types";

export function MailboxSetup({
  settings,
  api,
  onSaved,
}: {
  settings: LocalSettingsSummary;
  api: InboxZeroDesktopApi;
  onSaved: (settings: LocalSettingsSummary) => void;
}) {
  return (
    <main className="local-mailbox-setup">
      <section className="local-mailbox-card">
        <p className="local-login-brand">OneMail</p>
        <h1>Connect your mailbox</h1>
        <p>
          JYI is connected. Now connect the mailbox OneMail should read and send
          from.
        </p>
        <p className="local-login-note">
          Choose your provider, then enter your email and an app password. Most
          providers need an app password, not your normal sign-in password.
        </p>
        <MailboxForm
          api={api}
          onSaved={onSaved}
          submitLabel="Connect mailbox"
        />
        {settings.ai ? (
          <p className="local-login-note">
            JYI AI · {settings.ai.account_email ?? "Connected"}
            {settings.ai.spendable_credits == null
              ? ""
              : ` · Credits: ${(settings.ai.spendable_credits / 1_000_000).toLocaleString()}`}
          </p>
        ) : null}
      </section>
    </main>
  );
}
