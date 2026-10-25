# OneMail

OneMail is a hosted AI email workspace. It runs on Cloudflare Workers, signs users in through JYI, and connects Google mail through Nylas, Microsoft mail through Microsoft Graph, and other IMAP providers with app passwords. AI analysis is charged through the JYI gateway.

## Hosted capabilities

- Connect Google and Microsoft mailboxes with OAuth, or other IMAP mailboxes with an app password.
- Read, search, compose, send, archive, and organize mail from any device with a browser.
- Run AI analysis and assistant workflows through the JYI gateway.
- Keep mailbox credentials encrypted in the OneMail database; mailbox data is owned by the OneMail deployment.
- Use Cloudflare Queues and Cron Triggers for background sync, webhooks, and scheduled work.

Production deployment uses a dedicated OneMail Worker at `onemail.jyisolutions.com`, separate from the JYI main site. See [Cloudflare Workers deployment](docs/hosting/cloudflare-workers.mdx).

## Development

Use Node.js 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm web:dev
```

`pnpm web:dev` starts the hosted Next.js app. It requires the database, Redis, and provider configuration described in `apps/web/.env.example`; it is not the local desktop client.

## Hosted deployment

```sh
pnpm workers:build
pnpm preview:workers
pnpm workers:deploy
```

The deploy command provisions the app Worker and the internal documents Worker, and uses the Cloudflare Queues configured in `apps/web/wrangler.jsonc`. Database migrations run separately against the direct PostgreSQL connection before a release.

## Optional local desktop

The Tauri client in `apps/desktop-tauri` remains available as an experimental offline client. It connects directly to IMAP/SMTP, caches mail in local SQLite, and stores credentials in the operating system's credential store. It is not the main product.

```sh
pnpm desktop        # run the Tauri client
pnpm desktop:dist   # build locally; does not publish
```

See [Tauri desktop configuration](apps/desktop-tauri/README.md) for local setup and packaging details.

## Attribution and license

OneMail is built on [elie222/inbox-zero](https://github.com/elie222/inbox-zero). Existing upstream notices and licenses continue to apply; see [LICENSE](LICENSE).
