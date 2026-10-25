# OneMail — Local email assistant

OneMail is a desktop email assistant. Mail connects directly from your computer over IMAP/SMTP and is cached in local SQLite. AI analysis uses your JYI account and is charged through the JYI gateway.

**Closing the last window quits OneMail on Windows, macOS, and Linux.** Syncing, queued mail processing, and AI requests stop. Pending local operations can resume the next time you open the app. A message already accepted by your mail server cannot be recalled by closing OneMail.

## Current desktop capabilities

- Connect multiple IMAP/SMTP mailboxes with a password or app password.
- Read and search downloaded mail; open conversations and download attachments.
- Archive messages and change read status.
- Compose and queue plain text messages locally, with delivery status feedback.
- Ask JYI to analyze a selected conversation. Only downloaded messages included in the analysis dialog are sent when you click Analyze; attachments are excluded.
- Store mailbox passwords and JYI device credentials using the operating system credential store.

The Tauri app requires a JYI sign-in before opening the local mail UI. A OneMail mailbox subscription is not required, but AI analysis needs a JYI account with model access and sufficient credits. SQLite mail content itself is not encrypted by the app; protect the computer and its backups accordingly.

This desktop flow does not yet implement native Google/Microsoft OAuth, reply composition, attachment uploads, automated AI rules, meeting briefs, or cloud messaging integrations. Providers that disable password or app-password access need a future OAuth integration. The earlier hosted implementation remains in this repository as an optional deployment target.

## Development

Use Node.js 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm dev
```

The default command opens the local Tauri desktop interface. No OneMail web server, PostgreSQL, Redis, Nylas, or Resend is required for local mailbox operation. Configure your mail provider's IMAP/SMTP servers in Settings.

```sh
pnpm build          # Build the Tauri desktop app
pnpm desktop:dist   # Build the Tauri desktop app locally; does not publish
```

See [Tauri desktop configuration and packaging](apps/desktop-tauri/README.md) for JYI authorization, storage, signing, and release requirements. Real mailbox connections and live JYI login still need runtime validation.

## Optional hosted implementation

```sh
pnpm web:dev
pnpm workers:build
pnpm workers:deploy
```

These commands target the separate hosted application and require its own service configuration. See [Workers hosting](docs/hosting/cloudflare-workers.mdx). They are not part of normal desktop startup.

## Attribution and license

OneMail is built on [elie222/inbox-zero](https://github.com/elie222/inbox-zero). Existing upstream notices and licenses continue to apply; see [LICENSE](LICENSE).
