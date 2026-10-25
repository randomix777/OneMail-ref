# OneMail desktop

The default desktop product is a local email assistant built with Electron. Its renderer is bundled with the app. A utility process owns the SQLite mail engine and connects directly to mail servers using IMAP and SMTP.

## Run and package

From the repository root, use Node.js 24 and the pinned pnpm version:

```sh
pnpm install
pnpm dev
pnpm build
pnpm desktop:dist
```

Packaging never publishes automatically. Platform-specific commands are available:

```sh
pnpm --filter @inboxzero/desktop dist:win
pnpm --filter @inboxzero/desktop dist:mac
pnpm --filter @inboxzero/desktop dist:linux
```

Installers are written to `apps/desktop/release/`. The current migration has been type-checked but has not undergone desktop build, installer, or runtime validation.

## Mailbox setup and limits

In Settings, enter your mailbox address, username, password or app password, and IMAP/SMTP server names and ports. Saving verifies both server connections. Both direct TLS and required STARTTLS are supported; certificate validation stays enabled.

Native Google/Microsoft OAuth is not implemented in this local flow. Only accounts that permit password or app-password IMAP/SMTP access can connect. Both protocols currently use the same username and password.

The app enumerates all selectable IMAP folders, caches metadata, and downloads message bodies on opening conversations. Initial sync and subsequent inventory scans can be slow for large mailboxes. Search covers indexed local content. Message downloads are limited to 25 MiB; larger messages and their attachments are unavailable in this version.

The desktop UI supports inbox reading, search, archive, read status, attachment downloads, and basic new-message composition. Reply/forward composition, outgoing attachments, cloud integrations, and automatic AI rules have not been ported.

## Lifetime and delivery

Closing the last window quits the app on every platform, including macOS. No tray service or login daemon is installed. The mail utility process, IMAP/SMTP connections, and pending AI requests are closed. Keeping a window open allows sync and queue processing to continue.

Local operations survive restarts and can resume on the next launch. Closing the app does not recall a message already accepted by SMTP. An interrupted or partially accepted send remains unconfirmed and is not automatically resent; inspect the server's Sent folder and delivery notices before manually sending another copy. The compose dialog displays the current operation state.

## Storage

Files live under Electron's per-user `userData` directory:

- `local-mailbox.sqlite` and its SQLite sidecar files contain mail, downloaded bodies, drafts, and pending operations.
- `local-credentials.bin` contains encrypted mailbox credentials and JYI device credentials.

Credentials use Electron safeStorage with the OS credential store. A missing secure backend, including Linux `basic_text`, prevents saving credentials. Keys are held by the main process and the mail utility process; the renderer receives account summaries without saved passwords or AI keys.

Mail content in SQLite is **not encrypted by the application**. Disconnecting a mailbox removes its active local cache and queued operations, but is not a secure erase of disk pages, OS backups, or previously downloaded attachment files. Server mail is retained.

## JYI AI

Mailbox operation needs no JYI login. Use Connect JYI AI in Settings for optional analysis, account credit refresh, and the billing link.

The desktop client uses the system browser, PKCE S256, and the registered loopback callback at `http://127.0.0.1:5000/oauth/callback`. JYI permits another loopback port with the same host and path (RFC 8252 section 7.3), but the path must stay `/oauth/callback`. No OAuth client secret or shared gateway key belongs in an installer.

Public configuration is in `.env.example`:

| Variable | Purpose |
| --- | --- |
| `ONEMAIL_JYI_CLIENT_ID` | Public desktop client ID; default `onemail-desktop` |
| `ONEMAIL_JYI_AUTH_ORIGIN` | HTTPS identity origin |
| `ONEMAIL_JYI_GATEWAY_ORIGIN` | HTTPS AI gateway origin |

Supply these variables in the process environment when building to embed custom defaults, or when launching for development. The desktop build does not load `.env` files automatically. New variables also belong in `src/env.ts` and the root `turbo.json` build environment list.

Authorization uses `/connect/authorize` and `/oauth/token`; `/oauth/credential` refreshes credit information and `/oauth/revoke` disconnects the device. Model listing and analysis use the authenticated OpenAI-compatible gateway. The issued device key supplies billing identity. Requests do not invent user identity headers or embed a server credential.

Only a selected conversation's downloaded messages and the typed question are submitted when Analyze is clicked: at most 20 messages, first 20,000 characters each, excluding attachments. Answers are displayed as text and cannot execute mailbox actions. Paid analysis is not automatically retried. Insufficient credit, expired authorization, and unavailable models are reported to the user.

The JYI public client registration and live authorization/billing flow have not been validated by this migration.

## Releases

The existing Desktop Release workflow packages Windows and macOS builds from `desktop-v*` tags or manual dispatch. Publishing remains an explicit workflow option. macOS requires Developer ID signing and notarization credentials; Windows release signing uses Authenticode credentials. Review the workflow and `electron-builder.yml` before a release.

Optional crash reporting uses the build-time `INBOX_ZERO_SENTRY_DSN`. Without a DSN, local builds do not report to Sentry. Diagnostic exports can contain traces of local app activity; inspect them before sharing.

## Hosted implementation

The earlier hosted shell remains available explicitly with `INBOX_ZERO_LOCAL_MAIL=0` and its own hosted service configuration. It is not the default desktop product and has a different data and lifecycle model. See the root README for explicit web and Workers commands.
