import { useEffect, useState } from "react";

import { createRoot } from "react-dom/client";

import { MailEngineProvider } from "@inboxzero/mail-react/MailEngineProvider";

import { MailApp } from "@inboxzero/mail-ui/MailApp";

import { createMailIpcClient } from "@inboxzero/mail-core/protocol/mail-ipc-client";

import type { ConversationKey } from "@inboxzero/mail-core/identities";

import type { MailClient } from "@inboxzero/mail-core/engine";

import type { LocalSettingsSummary } from "./settings-types";

import type { InboxZeroDesktopApi } from "./desktop-api";

import { SettingsDialog } from "./SettingsDialog";

import { ComposeDialog } from "./ComposeDialog";

import { AnalysisDialog } from "./AnalysisDialog";

import { JyiLogin } from "./JyiLogin";

import { MailboxSetup } from "./MailboxSetup";

import "./local.css";

declare global {
  interface Window {
    inboxZeroDesktop?: InboxZeroDesktopApi;
  }
}

const api = window.inboxZeroDesktop;

if (!api?.mailEngine || !api.localAssistant)
  throw new Error("The local desktop assistant is unavailable");

const client = createMailIpcClient(api.mailEngine, {
  provider: "imap",

  push: {
    subscribe: api.mailEngineSubscribe,
    unsubscribe: api.mailEngineUnsubscribe,
    onSnapshot: api.onMailEngineSnapshot,
  },
});

const root = document.getElementById("root");

if (root) {
  const container = root;

  const desktopApi = api;

  api.localAssistant
    .settings()
    .then((settings) => {
      createRoot(container).render(
        <App initial={settings} api={desktopApi} client={client} />,
      );
    })
    .catch((error: unknown) => {
      container.textContent =
        error instanceof Error
          ? error.message
          : "The local assistant could not start";
    });
}

function App({
  initial,
  api,
  client,
}: {
  initial: LocalSettingsSummary;
  api: InboxZeroDesktopApi;
  client: MailClient;
}) {
  const [settings, setSettings] = useState(initial);

  if (api.requiresJyiLogin && !settings.ai) {
    return (
      <JyiLogin settings={settings} api={api} onConnected={setSettings} />
    );
  }

  return (
    <MailEngineProvider client={client}>
      <LocalAssistant
        initial={settings}
        api={api}
        client={client}
        onSettingsChange={setSettings}
      />
    </MailEngineProvider>
  );
}

function LocalAssistant({
  initial,
  api,
  client,
  onSettingsChange,
}: {
  initial: LocalSettingsSummary;
  api: InboxZeroDesktopApi;
  client: MailClient;
  onSettingsChange: (settings: LocalSettingsSummary) => void;
}) {
  const [settings, setSettings] = useState(initial);

  const updateSettings = (next: LocalSettingsSummary) => {
    setSettings(next);
    onSettingsChange(next);
  };

  const [settingsOpen, setSettingsOpen] = useState(false);

  const [composeOpen, setComposeOpen] = useState(false);

  const [analysis, setAnalysis] = useState<ConversationKey | null>(null);

  const accountIds = settings.accounts.map((account) => account.id);

  useEffect(() => {
    api.signalReady?.();
    return api.onOpenSettings?.(() => setSettingsOpen(true));
  }, [api]);

  return (
    <div className="local-app">
      <header className="local-app-status">
        <span>Local mail · works while OneMail is open</span>
        <button type="button" onClick={() => setSettingsOpen(true)}>
          {settings.ai
            ? `JYI AI · ${settings.ai.account_email ?? "Connected"}${settings.ai.spendable_credits == null ? "" : ` · Credits: ${(settings.ai.spendable_credits / 1_000_000).toLocaleString()}`}`
            : "Connect JYI AI"}
        </button>
      </header>
      {accountIds.length ? (
        <MailApp
          key={accountIds.join(":")}
          accountIds={accountIds}
          accounts={settings.accounts}
          host={{
            openSettings: () => setSettingsOpen(true),
            compose: () => setComposeOpen(true),
            analyzeConversation: setAnalysis,

            loadAttachment: async (input) =>
              new Blob([await api.readAttachment(input)]),
          }}
        />
      ) : (
        <MailboxSetup
          settings={settings}
          api={api}
          onSaved={updateSettings}
        />
      )}
      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          api={api}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {composeOpen ? (
        <ComposeDialog
          accounts={settings.accounts}
          client={client}
          onClose={() => setComposeOpen(false)}
        />
      ) : null}
      {analysis ? (
        <AnalysisDialog
          conversationKey={analysis}
          api={api}
          onClose={() => setAnalysis(null)}
        />
      ) : null}
    </div>
  );
}
