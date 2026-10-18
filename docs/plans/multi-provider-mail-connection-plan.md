# Multi-provider mail: connections, transports, and new mailbox services

Design and implementation reference for connecting mailboxes that are neither
Gmail-via-our-own-OAuth nor Outlook, and for moving Google mail onto Nylas.

Status: **P0 landed, P1 in progress** (§8 tracks both). The C1/C2 rule and the
resolved gates below are what the implementation follows; the gates still marked
open still need an answer, and several of them cost money or change user-visible
consent screens. Sections written as design ("this should…") describe the target
state; §8 is the authority on what is actually built.

Read in order:

1. [Objective and the constraint that shapes it](#objective)
2. [What the codebase research established](#research)
3. [Target architecture](#architecture)
4. [Transport A: Nylas for Google](#nylas)
5. [Transport B: IMAP/SMTP and direct OAuth](#imap)
6. [Data model and migrations](#data-model)
7. [Change inventory](#inventory)
8. [Work packages, sequence, and evidence](#packages)
9. [Decision gates](#gates)
10. [Risks](#risks)
11. [Testing strategy](#testing)
12. [Out of scope](#out-of-scope)

<a id="objective"></a>

## 1. Objective and the constraint that shapes it

Connect more mailbox services. The rule that decides every architecture
question below:

> Only Google requires CASA, so only Google is configured with Nylas. Every
> other provider goes through its own OAuth (or IMAP/SMTP) directly.

That is a cost decision, and it is coherent:

- Google's restricted Gmail scopes (the `gmail.modify` family we request today —
  `apps/web/utils/gmail/scopes.ts:11`) require an annual Tier 2/3 CASA assessment
  by a Google-authorized assessor. **Nylas
  proxies CASA for Google mail**: it maintains a Google Cloud project that has
  already passed Tier 3 and exposes it as the
  [Google Shared App](https://developer.nylas.com/docs/provider-guides/google/shared-gcp-app/).
  Building on it means no assessor, no remediation, no annual renewal — this
  assessment is not our obligation and is deliberately out of scope for this
  plan.
- Nylas is priced per connected grant. Microsoft, Yahoo, Zoho, Fastmail, iCloud,
  and generic IMAP need no CASA at all, so routing them through Nylas would add
  cost and a third party in the data path for no compliance benefit.

Three consequences must be stated up front, because they are easy to discover too
late:

**C1 — The proxy only holds while every Gmail scope is requested by Nylas'
OAuth client.** Today sign-in and mailbox connection are the same act:
`apps/web/utils/auth.ts:103-117` registers Google with
`scope: [...GMAIL_SCOPES]` (`apps/web/utils/gmail/scopes.ts:7-13` →
`gmail.modify`, `gmail.settings.basic`). CASA attaches to the *Cloud project
whose client requests the restricted scope*. While our own client ID asks for
`gmail.modify`, that consent is our application asking Google for restricted
access, and Nylas' certification does not extend to it. Dropping Gmail scopes
from our consent is therefore not extra compliance work — it is the condition
that makes the proxy effective, and it is why the plan retires
`/api/google/linking/*` for mail in favour of Nylas hosted auth.

**C2 — For Google, every API call goes through Nylas, and the scope set is
exactly Nylas' supported list.** Nylas forwards only scopes it supports: anything
outside its list is never sent to the provider, and requesting it returns
`400 common.scope_not_allowed`
([granular scopes](https://developer.nylas.com/docs/dev-guide/scopes/)). Our own
Google client keeps nothing but sign-in identity.

The governing rule for Google is therefore: **use Nylas for everything; if Nylas
does not have it, disable the feature.** No Google feature stays on our own
client, and nothing is reimplemented as a side channel.

The Google scopes Nylas supports (all `https://www.googleapis.com/auth/` except
`openid` and `https://mail.google.com/`):

| Area | Supported scopes | Notes |
| --- | --- | --- |
| Gmail read | `gmail.readonly` | Messages, attachments, drafts |
| Gmail read/write | `gmail.modify` | The workhorse: archive, read state, star, trash, label/move |
| Gmail send | `gmail.send` | Required for scheduled send |
| Gmail drafts | `gmail.compose` | Draft create/update/delete/send |
| Gmail labels | `gmail.labels` | List and edit labels |
| Gmail metadata | `gmail.metadata` | Optional; causes reduced-payload `.metadata` webhooks |
| All-access | `https://mail.google.com/` | Accepted but restricted; only for permanent delete — avoid |
| Contacts | `contacts.readonly`, `contacts.other.readonly`, `contacts`, `directory.readonly` | Includes `inbox` and `domain` sources |
| Calendar | `calendar`, `calendar.readonly`, `calendar.events`, `calendar.events.readonly` | Free/busy is served by `/calendars/free-busy` under `calendar.readonly` |
| Identity | `openid`, `userinfo.email`, `userinfo.profile` | Nylas adds these to every request |

Recommended minimum for this product: `gmail.modify` + `gmail.compose` +
`gmail.send`. Calendar and Contacts are not optional follow-ups — they are
supported by Nylas, so under the rule they move to Nylas too (§4.6). What Nylas
has no API for is disabled (C3).

**C3 — Everything Nylas has no API for is disabled for Google accounts.** The
features served by `gmail.users.settings.*` lose their Google implementation,
because `gmail.settings.basic` is absent from Nylas' scope list and there is no
Settings API. Per the rule, each one is **disabled**, not kept on a side channel:

| Feature | Current code | Disposition |
| --- | --- | --- |
| Gmail server-side filters (`createFilter`, `getFiltersList`, `deleteFilter`, `createAutoArchiveFilter`) | `utils/gmail/filter.ts:22,105,111` | **Disabled** for Google accounts |
| Send-as alias enumeration (`getSendAsAddresses`) | `utils/gmail/signature-settings.ts:26` | **Disabled** — returns empty; the compose alias picker goes away for Google |
| Gmail signature *from provider settings* (`getSignatures`) | `utils/gmail/signature-settings.ts:26` | **Disabled**. Nylas does not sync provider signatures and never applies them to Nylas-sent mail. OneMail's own stored signature plus `signature-extraction.ts` (which reads sent mail and still works) is the surviving path |
| Forwarding addresses (`getForwardingAddresses`) | `utils/gmail/settings.ts:6` | **Disabled** |
| Drive — both `drive.file` and full `drive` | `utils/drive/scopes.ts:19-29` | **Disabled** for Google accounts. Nylas has no Drive API, so document filing on Google is turned off |
| `calendar.freebusy` scope | `utils/gmail/scopes.ts:32` | Not needed — Nylas serves free/busy under `calendar.readonly` (§4.6) |

None of these are CASA issues; `gmail.settings.basic` is sensitive, not
restricted. They are the accepted cost of the rule.

**Two consequences to accept explicitly, since they are product-visible:**

- **Document filing becomes Microsoft-only.** Google accounts lose Drive-backed
  filing while Outlook accounts keep OneDrive. If that asymmetry is unacceptable,
  the only CASA-safe alternative is keeping `drive.file` on our own client
  (non-restricted, no assessment) — which the "everything through Nylas" rule
  rejects. Flagged once here, not revisited.
- **Google loses three long-standing conveniences** (server-side filters, send-as
  aliases, provider signatures). Users who configured any of them in Gmail will
  see them stop being reflected in OneMail. This belongs in release notes.

<a id="research"></a>

## 2. What the codebase research established

Verified by reading the code, not assumed. These findings set the shape of the
work; the third one in particular contradicts what the file names suggest.

**R1 — Mail is read from a local database, not from the provider API.** The
server is a stateless sync-and-mutation bridge. The browser runs a WASM SQLite
mirror in a worker (OPFS `.mail-engine/mailbox.sqlite`,
`apps/web/utils/mail-engine/wasm-sqlite.ts:9,27-40`) or, on desktop, node SQLite
over IPC. The list UI reads via `apps/web/app/(app)/[emailAccountId]/mail/use-engine-mail-threads.ts:49-52`
→ `observeMailboxWindow`; the reader via `apps/web/hooks/useThread.ts:57-60` →
`observeConversation`; there is no provider fallback
(`packages/mail-react/src/use-mailbox-window.ts:52-54`
returns an empty view when the engine client is absent). The provider is reached
only through `apps/web/utils/mail-api/source.ts` (a `MailboxSource`) and
`apps/web/utils/mail-api/operations.ts` (`applyChange`, `:308-390`), behind
`/api/mail/v1/accounts/[accountId]/*`.

**R2 — A new provider's real contract is much smaller than the 104-member
`EmailProvider` interface.** The live path needs about 35 methods:
`getMessagesWithPagination`, `getMailboxSyncPage`, `getMessage`, `getThread`,
`getThreadMessages`, `searchMessages`, `getFolders`, `getAttachmentStream`, the
`applyChange` mutation set (`operations.ts:322-390`), plus send/draft/label
basics. Roughly 45 more are mechanical wrappers, and roughly 20 can legitimately
throw or return empty — Gmail itself already stubs the folder group
(`apps/web/utils/email/google.ts:2129-2164`).

**R3 — `syncLocalMail()` and the whole `local-mail-sync` stack are dead code.**
They are a superseded first-generation design: zero production callers (only
`apps/web/utils/email/local-mail-sync-adapters.test.ts`). The single live use of
`localMailSyncStrategy` is `apps/web/utils/mail-api/source.ts:68`, which selects
`folder_delta` vs `account_history` for the engine's `describe()`. New providers
must **not** be built on `syncLocalMail`; `getMailboxSyncPage` is the real sync
primitive (`apps/web/utils/email/types.ts:303-308`).

**R4 — There is no server-side mail polling anywhere.** Rules and AI run from
webhooks. The only provider-independent poll is the local engine's 60-second idle
catch-up (`packages/mail-core/src/engine.ts:55`), which only runs while the app is
open. The Vercel cron and `docker-compose.yml:158-159` run `/api/watch/all`
hourly, which renews watches and fetches no mail. So a provider without webhooks
gets a fresh UI but **no server-side automation on new mail** until we add a
polling path (see §5.5).

**R5 — The provider identity is a hard two-value binary in 97 production files
under `apps/web`** (≈145 unique files repo-wide, 94 `isGoogleProvider` /
`isMicrosoftProvider` call sites, 48 strict `=== "google"` / `"microsoft"`
comparisons). Critically, the distribution is not uniform: the *new* layers
(`packages/mail-core`, `mail-sqlite`, `mail-react`, `mail-ui`, `packages/api`,
`apps/worker`, all `/api/mail/v1/**` routes, `docs/openapi.json`) are already
provider-agnostic, while the legacy `apps/web/utils` tree is where the binary
lives.

**R6 — The engine has three hard DB-level provider blockers**, which must be
changed before any new provider can store a single message:
`packages/mail-core/src/identities.ts:11` (`z.enum(["google","microsoft"])`),
`packages/mail-sqlite/src/migrations.ts:25`
(`CHECK (provider IN ('google','microsoft'))`), and
`packages/mail-sqlite/src/store.ts:2648`, whose `COALESCE((SELECT provider FROM
accounts …), 'google')` would silently label a third provider as Google.

**R7 — `watchEmails()` returning `null` is treated as failure, not "no push".**
`apps/web/utils/email/watch-manager.ts:302-303` turns it into
`Error("Provider returned no result for watch setup")` → a deduped error and a
per-account `{status:"error"}`. The hourly cron has no expiry precondition
(`:46-85`, `:291-299`), so a pushless provider would log a failed watch every
hour forever, and stamping a synthetic `watchEmailsExpirationDate` would trip the
lapse email (`utils/email/notify-lapsed-watches.ts:16-19,79-106`). This needs an
explicit capability, not a convention.

**R8 — The connection model is bound to sign-in.** `EmailAccount.accountId` is
required and unique (`prisma/schema.prisma:221-222`), 1:1 with better-auth's
`Account`. That is why email-code (OTP) sessions cannot connect a mailbox today
(`utils/oauth/account-linking.ts:159-200`, surfaced as
`provider_sign_in_required` at `app/(app)/accounts/page.tsx:340-346`): the
comment at `account-linking.ts:159-162` is explicit that a linked `Account` row
*is* a sign-in credential. Any new connection path has to answer this.

**R9 — `EmailAccount.email` is unique and `handleAccountLinking` falls back to
matching by email** (`utils/oauth/account-linking.ts:59-124`). A second Google
path that reuses `provider: "google"` with a different `providerAccountId` would
match the existing row and return `update_existing_account`, letting Nylas
overwrite a working direct-Gmail connection's tokens via `updateGoogleAccount`
(`app/api/google/linking/callback/route.ts:470-496`). Provider value alone
cannot distinguish the two paths; the discriminator must be explicit (§6.1).

<a id="architecture"></a>

## 3. Target architecture

### 3.1 Separate three things that are currently one string

Today `Account.provider` answers three different questions at once: what the
mailbox *is*, how we *talk* to it, and where its *credentials* live. Split them.

| Concept | Where it lives | Values | Answers |
| --- | --- | --- | --- |
| **Provider family** | `Account.provider` (existing) | `google`, `microsoft`, `yahoo`, `zoho`, `fastmail`, `icloud`, `imap` | Terminology (label vs category), which account-level features apply, which logo/label to show |
| **Transport** | `Account.transport` (**new**) | `oauth`, `nylas`, `imap` | Which `EmailProvider` to construct and which sync cursor family to use |
| **Credential** | `Account` OAuth columns (existing) or `MailboxCredential` (**new**, 1:1 with `EmailAccount`) | OAuth tokens; Nylas grant id; IMAP/SMTP host, port, username, encrypted secret | How to authenticate |

Why this split rather than a new `MailboxConnection` table that owns everything:
`Account` already *is* the linked-connection row for OAuth providers, holding
`provider`, `providerAccountId`, `access_token`, `refresh_token`, `expires_at`,
`scope`, `id_token`, and the Prisma extension already encrypts its tokens
(`utils/prisma-extensions.ts:15-16`). A parallel connection table would duplicate
that and force a nullable-`accountId` migration plus rewriting every
`emailAccount.account.provider` read (≈110 production sites in ≈60 files,
measured). Adding one discriminator column to `Account` and one credential table
for the secrets we do not already have achieves the same separation with a
fraction of the blast radius.

The tradeoff is honest and worth recording: an IMAP mailbox gets an `Account` row
whose `provider` is `imap` or a vendor name. That row can never authenticate a
sign-in, because no such better-auth social provider exists — so it is inert for
auth purposes. If we later want better-auth's `Account` to mean strictly
"sign-in identity", the nullable-`accountId` refactor remains available; we are
not painting ourselves into a corner, because the family/transport indirection
introduced here is exactly what such a refactor would preserve.

**What this buys immediately (R8):** email-OTP sessions become able to connect a
mailbox. The blocking check exists so an email-code session cannot mint a sign-in
credential; an IMAP or Nylas connection mints none. That is a product
improvement, and it should be called out in release notes rather than slipped in.

### 3.2 Provider registry and capabilities (replaces the else-chains)

The 48 strict comparisons and 94 predicate calls are mostly asking a *capability*
question with a provider question. The fix is one registry plus explicit
capabilities, then mechanical replacement of the else-chains.

```ts
// apps/web/utils/email/providers/registry.ts
export type ProviderFamily =
  | "google" | "microsoft" | "yahoo" | "zoho" | "fastmail" | "icloud" | "imap";
export type MailTransport = "oauth" | "nylas" | "imap";

export type ProviderCapabilities = {
  /** Gmail-style labels; false means folder/category semantics. */
  labels: boolean;
  /** Server-side filter rules (Gmail filters / Graph rules). */
  serverFilters: boolean;
  /** Star/flag support. */
  starred: boolean;
  /** How new mail reaches the server pipeline. */
  push: "webhook" | "poll";
  sendAs: boolean;
  contactPhotos: boolean;
  folderCounts: boolean;
};

export type ProviderDefinition = {
  family: ProviderFamily;
  transport: MailTransport;
  label: string;                       // "Gmail", "Outlook", "Yahoo Mail", "IMAP"
  logo: string;                        // /images/<name>.svg
  capabilities: ProviderCapabilities;
  oauth?: { authorizeUrl: string; tokenUrl: string; scopes: string[];
            clientIdEnv: string; clientSecretEnv: string;
            xoauth2: boolean; discoveryUrl?: string };
  imap?: { host: string; port: number; secure: boolean; smtpHost: string;
           smtpPort: number; smtpSecure: boolean; auth: "password" | "xoauth2" };
};
```

Rules for the refactor, so it does not sprawl:

- Where a branch asks "does this provider store labels or folders?", replace it
  with a capability lookup. `apps/web/utils/terminology.ts:18` is the canonical
  example (`isMicrosoftProvider(provider) ? categories : labels`).
- Where a branch asks "is this Gmail specifically?" because the *code path* is
  Gmail-only (label colors, `createFilter`, `getForwardingAddresses`), keep the
  capability check and let unsupported providers report the feature as
  unavailable instead of falling into an Outlook-shaped else-branch.
- Never extend `isGoogleProvider` / `isMicrosoftProvider` to cover new families.
  They stay family predicates; call sites move to capabilities. This is the
  single most important discipline in the whole plan, because an un-refactored
  else-chain silently routes a Yahoo account into Microsoft behaviour.

### 3.3 The engine seam is already the right shape

No new abstraction is needed for sync. A provider implements `EmailProvider` and
the existing adapter does the rest:

```
browser sqlite  ←  /api/mail/v1/accounts/:id/*  ←  mail-api/source.ts (MailboxSource)
                                                 ←  mail-api/operations.ts (applyChange)
                                                 ←  EmailProvider  ←  transport
```

Required from a new provider, and nothing more: `getMessagesWithPagination`
(enumerate), `getMailboxSyncPage` (delta + `reset` semantics), `getMessage`
(hydrate body), `getThread` / `getThreadMessages` (conversation membership),
`getAttachmentStream`, `searchMessages` (may return `unsupported`), the
`applyChange` mutations, and `ParsedMessage` fidelity — read/starred/inbox/sent/
draft/trash/spam are derived from `labelIds` and `parentFolderId`
(`apps/web/utils/mail-api/observations.ts:25-83`), so the provider must map its
own flag model onto those conventions.

Two generalizations are needed in the adapter, because today they key off the
literal `"microsoft"`:

- `source.ts:78,191-193,492` — folder scopes and per-folder stream ids are
  Microsoft-only. A second folder-delta provider must trigger them too.
- `source.ts:61` — `maxPageSize` 20 vs 50 should come from the registry.

The sync cursor union (`apps/web/utils/email/mailbox-sync.ts:4-27`) gains one
variant per *sync source*, not per provider family: `gmail-history`,
`outlook-delta`, `nylas-cursor`, `imap-uid`. Cursors are opaque and
source-specific; keying them by transport keeps a Nylas-backed Google account
from being handed a Gmail `historyId` cursor it cannot use.

<a id="nylas"></a>

## 4. Transport A: Nylas for Google

### 4.1 Why the Shared App, and what it costs

The [Google Shared App](https://developer.nylas.com/docs/provider-guides/google/shared-gcp-app/)
lets users authenticate through Nylas' verified OAuth application. Nylas owns the
Cloud project, the consent screen, the client credentials, token storage and
refresh, and the ongoing CASA renewals; we still choose scopes and still make all
API calls. **Nylas proxies CASA for these scopes** — the assessment is theirs, not
ours, and we inherit it by using their client.

Prerequisites and constraints, all from Nylas' documentation:

- It is **paid**: self-service via the Accelerator add-on on the **annual Pro
  plan**, or as an Enterprise add-on (**Gate G1**). This is a commercial
  question, not a compliance one.
- **The purchase is a launch gate for Google, not a development gate.** Until it
  is on the plan, a Google connector can only run on *our own* Google Cloud
  project — and an app in Google's testing status is capped at 100 authenticated
  accounts with 7-day refresh tokens, while publishing it to real users with
  restricted Gmail scopes requires the CASA assessment we are avoiding. So
  development proceeds without the add-on (§4.7), but no real Google user can be
  served until either the add-on is purchased or we accept CASA.
- The consent screen shows **"Nylas"**, not our brand. Whitelabeled hosted auth is
  explicitly incompatible with the Shared App (the OAuth client belongs to Nylas,
  so a custom callback host ends in `redirect_uri_mismatch`). Branding is a
  product decision, not a technical one (**Gate G1**). Note the trade: white-
  labeling would mean our own Cloud project, and with it CASA — which is exactly
  what we are avoiding.
- **Switching a connector to the Shared App forces re-authentication and new grant
  IDs.** Tokens cannot migrate between Cloud projects. This is why the flip must
  happen **before any external user connects Google**. Confirmed: OneMail has no
  existing Google accounts, so the flip costs nothing and §4.5 has no migration to
  plan.

### 4.2 Authentication model: grant id, no provider tokens

Using [Hosted OAuth with an API key](https://developer.nylas.com/docs/v3/auth/hosted-oauth-apikey/),
our backend exchanges the one-time `code` for a **grant id** and nothing else
matters:

```
GET  {api}/v3/connect/auth?client_id=…&redirect_uri=…&response_type=code
     &provider=google&state=…&login_hint=…
   → user consents → redirect to our callback with ?code=…
POST {api}/v3/connect/token   { client_id, client_secret: NYLAS_API_KEY,
                                grant_type: "authorization_code", code, redirect_uri }
   → { access_token, token_type, id_token, grant_id }
```

Nylas stores and refreshes the user's provider tokens; every subsequent call is
`/v3/grants/{grant_id}/…` with our API key. So:

- `Account.providerAccountId` = **grant id**; `Account.transport` = `"nylas"`;
  `Account.provider` stays `"google"` (this is what keeps the ≈110 existing
  `account.provider` reads meaningful, per R9's warning about needing an explicit
  discriminator — read `transport`, never infer from `providerAccountId`).
- No tokens are written to `Account.access_token` / `refresh_token`. Token
  refresh, `saveTokens` (`utils/auth/save-tokens.ts`), `getGmailClientWithRefresh`
  and the `cleanupInvalidTokens` path are bypassed for these accounts; grant
  health comes from Nylas' `grant.expired` webhook instead.
- Nylas allows **one grant per email address per application**. A reconnect
  therefore updates the existing grant rather than creating a duplicate, which we
  should assert in the linking flow rather than assume.

### 4.3 Connection flow

Mirror the existing linking pair so all the hard-won plumbing is reused: signed
state (`utils/oauth/state.ts`), state-cookie validation
(`utils/oauth/callback-validation.ts`), Redis code de-duplication
(`utils/redis/oauth-code.ts`), the linking decision table
(`utils/oauth/account-linking.ts`), and the redirect/audit helpers.

- `apps/web/app/api/nylas/linking/auth-url/route.ts` — `withAuth`, email-OTP
  policy, optional `emailAccountId` reconnect target, build the `/v3/connect/auth`
  URL with signed state, set the state cookie.
- `apps/web/app/api/nylas/linking/callback/route.ts` — validate state, exchange
  the code, resolve the mailbox address from the grant, run the linking decision,
  then create or update the `Account` row with `transport: "nylas"`.
- `utils/nylas/client.ts` — thin SDK wrapper (`nylas` v7+, server-only) with 429
  handling that honours `Retry-After` and jittered backoff.

`getAccountLinkingUrl` (`apps/web/utils/account-linking.ts:16-54`) currently maps
`"microsoft" → /api/outlook/…` and everything else → `/api/google/…`. That
implicit fallback is exactly the kind of else-chain that misfires; replace it with
a registry lookup keyed by family. **Landed** — the registry declares
`linkingEndpoint` and `label` per family and the helper fetches that route (see
P1, "Connect path").

### 4.4 The provider implementation and new-mail delivery

`apps/web/utils/nylas/mail-provider.ts` implements `EmailProvider` with
`name = "google"` (family) and `transport = "nylas"`. Mapping notes:

- **Folders and labels are one API.** Nylas' Folders API unifies Gmail labels and
  IMAP/Graph folders and returns RFC 9051 `attributes` (`\Inbox`, `\Sent`,
  `\Trash`, `\Junk`, `\Drafts`, `\Archive`), which is exactly the role mapping
  `observations.ts` needs. Nylas also flattens nested folders and returns
  `parent_id`. Read `id` and `attributes`, never folder names.
- **No nested-folder or `in:inbox` query support**; always resolve ids first.
- **Threads** exist (`thread_id` on messages), so conversation membership maps
  cleanly.
- **Send with attachments** has three regimes: inline base64 (3 MB body cap),
  `multipart/form-data` (25 MB), and the attachment-upload API (150 MB). This
  interacts with the two draft-attachment protocols already modelled in
  `utils/email/types.ts:40-53`; the Nylas provider should pick the
  whole-message-replacement shape rather than inventing a third.
- **Search**: pass Gmail operators through `search_query_native`.
- **Signatures have no provider sync.** Nylas never reads or applies the Gmail
  signature; implement `getSignatures()` from OneMail's own stored signature or
  Nylas' Signatures API, and expect the provider-signature behaviour to change
  (C3).
- **Settings-backed methods are disabled, not reimplemented.** `createFilter`,
  `getFiltersList`, `deleteFilter`, `createAutoArchiveFilter`, `getSendAsAddresses`
  and `getForwardingAddresses` return empty or throw a capability error. This has
  real consequences for sender blocking and unsubscribe
  (`utils/senders/filters.ts`), which currently ride on Gmail filters and must be
  turned off for Google accounts rather than reimplemented (C3).
- **`getMailboxSyncPage`**: Nylas has no Gmail-style global change log. Use a
  per-folder cursor over message listing plus webhook-driven deltas, and return
  `reset: true` when a cursor is unusable so the engine re-bootstraps.

New-mail delivery is **app-level**, which is simpler than both existing
providers: one webhook for the whole application rather than per-account
subscriptions.

- `apps/web/app/api/nylas/webhook/route.ts` — answer Nylas' `GET ?challenge=…`
  verification by echoing the exact challenge value; verify
  `X-Nylas-Signature` as HMAC-SHA256 over the **raw** body with the webhook
  secret; respond 2xx fast and defer work with `after()`, like both existing
  routes.
- Triggers: `message.created`, `message.updated`, `message.deleted`,
  `grant.expired` (and the `.truncated` variants — re-fetch the object by id;
  payloads cap at 1 MB). Route by `grant_id` → `Account.providerAccountId`.
- Call `notifyMailboxChanged` (`utils/mailbox-push.ts:11-24`) so the local engine
  refreshes, then hand off to the shared pipeline via a new branch in
  `utils/webhook/process-history.ts:34-81` (which today throws
  `Unsupported provider`). Do **not** write a second processor.
- `watchEmails()` becomes unnecessary for these accounts; with the capability
  from §3.2 (`push: "webhook"`, app-level) the hourly watch job skips them
  instead of recording a failure every hour (R7).

Rate limits to respect: 200 req/s per grant, 50 req/s per application, 10 req/s
for multipart send. The existing per-provider rate-limit metadata
(`utils/email/rate-limit-mode-error.ts:11-25`) and `local-mail-sync-budget.ts`
policies need Nylas entries; the `satisfies Record<…>` type makes that a compile
error until it is done, which is a feature.

### 4.5 No migration: the direct Gmail path is deleted, not coexisted

Confirmed: **no environment holds real Google accounts.** OneMail is pre-launch,
so there is nothing to migrate and no reason to keep two Google transports alive.

The consequences, all simplifications:

- P1 **deletes** the direct Gmail mail path instead of adding a transport switch
  beside it: `utils/email/google.ts`, the `utils/gmail/**` client tree that exists
  only to drive it, the Gmail linking routes, the Pub/Sub webhook
  (`app/api/google/webhook`), and `GMAIL_SCOPES` from our own consent. What
  survives from the Gmail tree is only what other subsystems legitimately still
  use (nothing, once Calendar and Contacts move per §4.6 — verify at edit time
  rather than assuming).
- No reconnect banner, no lapse flow for a legacy Google transport, no
  dual-transport `Account.transport` matrix beyond the `nylas` / `oauth` (for
  Microsoft) / `imap` cases that genuinely exist.
- `lastSyncedHistoryId` and the Gmail history-cursor variant become dead once the
  direct path is gone; a Nylas-backed Google account uses the `nylas-cursor`
  variant (§3.3). Drop the Gmail cursor variant rather than leaving it
  unreachable.
- Gate G3 is retired.
- The local engine's `accounts.provider` stays `google` for these accounts, so no
  engine schema change is needed for P1 at all (R6 remains a P2 concern).

Had external Google accounts existed, this would have been the expensive section:
no automatic token migration is possible between Cloud projects, every user would
have to re-authenticate, and both transports would have to coexist for a window.
Building before launch is what removes that cost — worth recording so the decision
to buy the add-on "at launch" is not re-litigated later on the assumption that a
migration was already paid for.

### 4.6 Calendar and Contacts move to Nylas as well

Under the C2 rule these are not optional: Nylas supports both, so Google calendar
and contacts access goes through Nylas and nothing stays on our own client.

- **Contacts** map cleanly. Nylas' Contacts API covers what
  `@googleapis/people` does today: `searchContacts` and `getContactPhotos`
  (`contacts`, `contacts.readonly`, `contacts.other.readonly` for the `inbox`
  source, `directory.readonly` for the `domain` source). The contacts code sits
  behind `apps/web/utils/gmail/contact.ts` and `utils/email/contact.ts`, so the
  seam exists but the client swap touches every contact caller.
- **Calendar** is the larger move. The app has its own calendar subsystem —
  `CalendarConnection` (its own OAuth tokens, `prisma/schema.prisma:1499-1517`),
  `utils/calendar/{client,event-provider,unified-availability,invitations}`,
  availability and booking, meeting briefs, and the meeting recorder. All of it
  currently talks to Google Calendar and Graph directly. Moving the Google half
  onto Nylas means a new calendar provider behind whatever `event-provider.ts`
  and the availability providers already abstract, plus re-plumbing
  `CalendarConnection` to hold a grant id instead of Google tokens.
- Practical difference from mail: `CalendarConnection` is *not* the mail
  `Account`, it has its own token columns and its own refresh path
  (`utils/calendar/client.ts`, `utils/calendar/save-calendar-tokens.ts`). Those
  either gain a Nylas equivalent or are retired for Google.

This is a second, distinct workstream from the mail transport and should be
planned and estimated separately (§8, P1b). It does not block P1.

### 4.7 Development stage: how to build this before the add-on is purchased

**First, the thing that is easy to misread: production needs no Google Cloud
project of ours.** With the Shared App, Nylas owns the Cloud project, the consent
screen, the client credentials, the Pub/Sub plumbing, and the CASA renewals. Our
code never talks to Google — only to Nylas. A GCP project appears below for one
reason only: without the add-on, Nylas has no Google credentials it can use on our
behalf, so a Google connector has to be given *someone's* — and the only ones
available are ours. That is a development-time credential loan, not a second
transport.

The connector's credentials are **Nylas Dashboard configuration, not code**: our
code only ever needs `NYLAS_API_KEY`, `NYLAS_CLIENT_ID`, the region/API URI, and
the webhook secret. Flipping to the Shared App later is a connector toggle, not a
release.

Two ways to validate Google during development, pending Nylas' answer below:

**A — throwaway Google Cloud project (only if we want the real path exercised
before the add-on).**

1. A throwaway Google Cloud project with the Gmail/People/Calendar APIs enabled, a
   Pub/Sub topic (**required for a Google connector that uses the Email API**), and
   OAuth credentials whose redirect URI is
   `https://api.us.nylas.com/v3/connect/callback` (or the EU host). Those
   credentials go on a **development connector** in the Nylas Dashboard — never in
   our env files as the primary path.
2. **Expect the dev connector to be an unverified app.** Google caps it at 100
   authenticated accounts and expires refresh tokens after ~7 days. The expiry is
   an annoyance for manual testing and a *free* way to exercise the `grant.expired`
   reconnect flow repeatedly, which is otherwise hard to test.
3. **Keep a dev/prod connector split** (Nylas recommends separate Google Cloud
   apps for test and production, because small changes on a verified app can
   trigger re-verification). Our app never needs to know which is in use.
4. **CI must not depend on live Google.** Integration tests run against a mocked
   Nylas API; the live dev connector is for manual end-to-end verification of the
   hosted-auth handshake, webhook delivery, and grant expiry.

**B — no GCP at all (recommended default).** Build the whole Nylas path against a
mocked Nylas API, which covers hosted-auth code exchange, the grant-id model,
webhook signature and challenge handling, and the sync/mutate flows. The real
Google handshake — hosted auth, webhook delivery, grant lifecycle — gets its first
live run at the moment the add-on is enabled, which is already a required
pre-launch step (below). Nothing needs creating or cleaning up, and no throwaway
credentials ever exist. The only cost is that a connector/scope misconfiguration
surfaces at the Shared App switch instead of earlier.

**Open question with Nylas (blocking the A-vs-B choice, not the code).** The docs
offer the Shared App only through the annual Pro plan plus the Accelerator add-on,
or an Enterprise add-on, and mention no development exception. Ask Nylas support:

1. Can the Shared App be enabled on a **development/staging** application without
   the add-on, e.g. during a trial or sandbox period? If not, what is the minimum
   commitment that enables it before production?
2. Without the Shared App, is it correct that a Google connector must use our own
   Google Cloud OAuth credentials plus our own Pub/Sub topic?
3. When an existing connector switches to the Shared App, do all grants created on
   our own credentials have to re-authenticate and take new grant IDs?
4. Beyond the connector setting, does enabling the Shared App require anything
   from us — new scopes, a different callback URI, or an org-level enablement
   delay?
5. With the Shared App, who owns the Pub/Sub topic used for Gmail notifications —
   do we still configure one?

An answer of "development applications can use it" collapses A and B into B with
no downside, and GCP disappears from this plan entirely.

**Pre-launch checklist item.** Before the first external user connects Google:
purchase the add-on, switch the production connector to the Google Shared App
credentials, confirm the connector's scope list matches C2, and only then open
Google sign-up. Doing it in this order means no user ever re-authenticates for
the switch and no grant IDs are orphaned. If Google is ever exposed to real users
on our own credentials, we have implicitly accepted our own CASA assessment.

<a id="imap"></a>

## 5. Transport B: IMAP/SMTP and direct OAuth

### 5.1 Provider matrix (with verification status)

| Provider | Family | Auth | Mail protocol | Verified |
| --- | --- | --- | --- | --- |
| Gmail | `google` | Nylas hosted auth | Nylas v3 | Yes |
| Outlook / M365 | `microsoft` | Existing direct OAuth | Graph | Yes — unchanged |
| Zoho Mail | `zoho` | OAuth 2.0 | REST Mail API **or** IMAP | OAuth flow verified against Zoho docs (`accounts.zoho.com/oauth/v2/auth`, refresh via `grant_type=refresh_token`, `Authorization: Zoho-oauthtoken`); REST-vs-IMAP is **Gate G4** |
| Yahoo Mail | `yahoo` | OAuth 2.0 | IMAP/SMTP XOAUTH2 | OAuth 2.0 authorization-code flow confirmed; **mail scopes and IMAP XOAUTH2 endpoints unverified** — confirm before building |
| Fastmail | `fastmail` | App password (JMAP/OAuth support for IMAP unverified) | IMAP/SMTP | Unverified — treat as app password initially |
| iCloud | `icloud` | App-specific password | `imap.mail.me.com` / `smtp.mail.me.com` | Endpoints per Nylas' iCloud guide |
| Generic / self-hosted | `imap` | Password or app password | User-supplied host/port | Yes |

Consumer providers in this table (Yahoo, iCloud, 163/QQ, corporate IMAP)
generally require an **app-specific password** rather than the account password,
and several require IMAP to be enabled in the provider's own settings first.
Onboarding copy has to carry that guidance or support load follows.

### 5.2 Credentials

New `MailboxCredential` model, 1:1 with `EmailAccount` (details in §6.2). Secrets
go through the existing versioned encryption helper
(`utils/encryption.ts` → `encryptToken` / `decryptToken`,
`EMAIL_ENCRYPT_SECRET` / `EMAIL_ENCRYPT_SALT`) rather than the Prisma extension,
because the IMAP password is a field we may later want to rotate and version
independently. Do not store secrets in fields that are queried by value
(`utils/prisma-extensions.ts:11-14`).

Validation on connect: open an IMAP connection, `LIST` folders, and authenticate
SMTP before persisting, so a bad host/port fails in the form rather than as a
broken account. For XOAUTH2 providers, validate the token the same way.

### 5.3 Sync: IMAP maps to folder-delta

IMAP's natural cursor is per-folder `UIDVALIDITY` + `UIDNEXT` (and `HIGHESTMODSEQ`
with CONDSTORE/QRESYNC where offered). That is the `folder-delta` strategy, which
means the Microsoft-only branches in `source.ts:78,191-193,492` must be
generalized (§3.3) — this is the concrete reason that generalization is in scope
rather than optional.

`reset_required` must be returned whenever `UIDVALIDITY` changes, since UIDs are
then meaningless; the engine re-bootstraps.

### 5.4 Libraries

`imapflow` (connection pooling, IDLE, CONDSTORE/QRESYNC, XOAUTH2), `mailparser`
(MIME → the `ParsedMessage` shape), and `nodemailer` (already a dependency) for
SMTP with either a password or XOAUTH2. None are currently in the lockfile, so
these are new dependencies — a supply-chain review item, not just an install.

### 5.5 The gap that must be closed: server-side automation without webhooks

Per R4, nothing server-side fetches mail today. Consequences by transport:

- **Nylas (Google)**: solved by the app-level webhook (§4.4).
- **IMAP/OAuth providers with webhooks**: none of the providers in §5.1 offer a
  usable mail webhook. So:
  - The **UI stays fresh** with no extra work — the local engine's 60-second idle
    catch-up calls `getMailboxSyncPage` while the app is open.
  - **Rules and AI do not run on new mail while the app is closed.** This is a
    product-visible regression risk if those providers are presented as
    first-class, and it is the largest single piece of new infrastructure in this
    plan.

Recommendation (Gate G6): add a bounded, cursor-driven poll rather than IMAP
IDLE. A cron or worker job walks poll-only accounts, advances each folder cursor,
and feeds new messages through the **same** `processHistoryItem` pipeline the
webhooks use — one code path for automation regardless of transport. Budget it
per account and per run, skip disconnected/unsubscribed accounts, and reuse the
existing Outlook reconcile shape (`utils/outlook/backfill-recent-messages.ts`)
rather than writing a second reconciler. IDLE can be a later optimization if
latency proves to matter; it costs long-lived connections, reconnection logic,
and a place to host them.

<a id="data-model"></a>

## 6. Data model and migrations

### 6.1 `Account` — add the transport discriminator

```prisma
model Account {
  // …existing fields…
  transport String @default("oauth") // "oauth" | "nylas" | "imap"
}
```

`provider` stays the family and keeps `@@unique([provider, providerAccountId])`.
`transport` is the explicit discriminator R9 demands: a Nylas-backed Google
account is `provider: "google"`, `transport: "nylas"`, so it can never be confused
with — or overwrite — a direct Google account's tokens. At the development stage
the direct Google path is deleted rather than kept (P1), so nothing can collide
today; the column is still required to distinguish `oauth` / `nylas` / `imap`, and
it is what keeps a future second path from reintroducing R9's bug.

No backfill is needed: the default `oauth` covers Microsoft and the other
direct-OAuth providers, IMAP connections are created with `imap`, and Google
connections are created with `nylas` from the start. There are no pre-existing
Google rows to migrate (§4.5).

### 6.2 `MailboxCredential` — new

```prisma
model MailboxCredential {
  id             String   @id @default(cuid())
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  // IMAP/SMTP, used when Account.transport = "imap"
  imapHost       String
  imapPort       Int
  imapSecure     Boolean  @default(true)
  smtpHost       String
  smtpPort       Int
  smtpSecure     Boolean  @default(true)
  authMethod     String   @default("password") // "password" | "xoauth2"
  username       String
  secret         String?  @db.Text // encrypted via encryptToken
  lastValidatedAt DateTime?

  emailAccountId String   @unique
  emailAccount   EmailAccount @relation(fields: [emailAccountId], references: [id], onDelete: Cascade)
}
```

`EmailAccount.accountId` stays required and unique (§3.1 explains why). Adding
this model is additive: no existing column changes, no data migration.

### 6.3 Engine-visible enums and constraints (R6)

These three must change or a new provider cannot store a message:

1. `packages/mail-core/src/identities.ts:11` — widen `providerSchema`.
2. `packages/mail-sqlite/src/migrations.ts:25` — the `provider` CHECK. SQLite
   cannot alter a CHECK in place, so this needs a table-rebuild migration in the
   engine's own migration chain, plus verification that existing OPFS/desktop
   databases upgrade cleanly (a rebuilt `accounts` table must not drop local
   mail).
3. `packages/mail-sqlite/src/store.ts:2648` — remove the `'google'` COALESCE
   default so a missing provider row fails loudly instead of mislabelling mail.
   Also `store.ts:2256,2343` casts, and the client unions in
   `utils/mail-engine/{worker-protocol,create-browser-engine,tab-channel,desktop-ipc}.ts`.

Because `accounts.provider` in the local engine is a *family*, Nylas-backed Google
keeps `google` here — no engine schema change is needed for Phase 1 at all. The
enum widening is a Phase 2 concern, which is a useful sequencing property.

<a id="inventory"></a>

## 7. Change inventory

Counts are measured; line numbers for the high-traffic files are verified, and
lower-traffic ones should be re-confirmed at edit time.

| Area | Files | Sites | Nature of change |
| --- | --- | --- | --- |
| A. Type unions / enums | ~22 | ~30 | Widen `EmailProvider.name` (`utils/email/types.ts:427`), the two predicates, cursor union, mail-core/engine unions, 3 DB/CHECK blockers |
| B. Factory + dispatch | ~24 | ~45 | `createEmailProvider` (`utils/email/provider.ts:23-47`) becomes a transport registry lookup; remove `Unsupported provider`; capability-replace else-chains (see §3.2) |
| C. Rate limit + health | ~9 | ~30 | Add Nylas/IMAP metadata and quota envelopes; the `satisfies Record<…>` type enforces completeness |
| D. Webhooks + watches | ~15 | ~30 | New Nylas route + `process-history` branch; watch capability so poll-only providers are skipped, not failed |
| E. Calendar / Drive / recorder | ~32 | ~120 | Calendar and Contacts gain a Nylas implementation for Google (P1b); Drive-backed filing is disabled for Google (C3); meeting recorder and booking meeting links are unaffected |
| F. Auth / linking / mobile + desktop | ~20 | ~60 | New Nylas linking pair; generalize `shouldLinkEmailAccount` / `getProfileData` (`utils/auth.ts:601-646`); widen mobile (`utils/mobile-auth/providers.ts:3-7`) and desktop (`utils/desktop-app.ts:2`, `apps/desktop/src/desktop.ts:7`) unions |
| G. UI pickers / labels | ~30 | ~70 | `AddAccount.tsx` becomes registry-driven; add a credentials form; capability-drive terminology and feature visibility |
| H. Analytics / logging | ~8 | ~20 | Extend the auth-funnel allowlist; logging is provider-agnostic by construction |
| I. Docs / CLI / CI | ~30 | ~60 | Hosting docs, `packages/cli` setup prompts + terraform vars, and the five CI workflows that hard-code dummy provider credentials |

Already provider-agnostic and cheap: `packages/mail-react`, `mail-ui`,
`email-editor`, `api`, `tinybird`, `apps/worker`, `unsubscribe-worker`,
`image-proxy*`, every `app/api/mail/v1/**` route, and `docs/openapi.json`
(verified: no provider enum).

Highest-leverage files, in order:

1. `apps/web/utils/email/types.ts:427` + `provider-types.ts:1-11` — the root union
   and the two predicates.
2. `apps/web/utils/email/provider.ts:23-47` + `rate-limit-mode-error.ts:48-53` —
   the gate that currently makes a third provider impossible to even construct.
3. `packages/mail-core/src/identities.ts:11` + `mail-sqlite/src/migrations.ts:25`
   + `store.ts:2648` — engine and storage acceptance.
4. `apps/web/utils/mail-api/source.ts:61,78,191-193,492` — the heaviest single
   behavioural branch file.
5. `apps/web/utils/auth.ts:601-646` — profile fetch and `shouldLinkEmailAccount`.
6. `apps/web/utils/terminology.ts:18` — the canonical capability else-chain.

**Dead code to retire while we are here (R3):** `EmailProvider.syncLocalMail` and
`localMailSyncStrategy` on the provider classes, `utils/email/local-mail-sync-types.ts`,
`utils/email/local-mail-sync-budget.ts`, `utils/gmail/local-mail-sync.ts`,
`utils/outlook/local-mail-sync.ts`, `utils/actions/local-mail-sync.validation.ts`,
and their tests. Removing them shrinks every future provider's required surface
and eliminates a documented-but-unused phase protocol that new contributors would
otherwise copy. Keep only what `source.ts:68` needs, replaced by a capability.

<a id="packages"></a>

## 8. Work packages, sequence, and evidence

Rough sizes are for one experienced engineer on this codebase; they are estimates,
not commitments.

### P0 — Foundations and capability refactor — LANDED

Introduce the registry, capabilities, and `Account.transport`; replace the
else-chains that ask capability questions; remove the dead `syncLocalMail` stack.
No user-visible behaviour change.

What landed:

- `utils/email/provider-registry.ts` — `PROVIDER_FAMILIES`, `MailTransport`,
  `ProviderCapabilities`, and the per-family `PROVIDER_DEFINITIONS` record.
  `EmailProvider["name"]` is now `ProviderFamily`, so the registry is the single
  source for the family union.
- `utils/email/account-transport.ts` — reads `Account.transport`, falling back to
  the family default for accounts predating the column.
- `prisma` — `Account.transport` with a `"oauth"` default and migration
  `20261017180000_add_account_transport`.
- `createEmailProvider` resolves (family, transport) and dispatches through an
  exhaustive switch with **no default branch**, so adding a family is a compile
  error instead of a silent fall-through to Outlook. An unimplemented transport
  throws rather than building a client that would act on the wrong provider.
- Capability conversions: `utils/terminology.ts` (labels vs categories),
  `utils/ai/split/prompt-to-split.ts` (star support), and the load-bearing
  branches in `utils/mail-api/source.ts` (`syncPageSize`, folder scopes, per-folder
  stream ids, and the catch-up fallbacks) now key off the registry or the sync
  strategy instead of `provider.name === "microsoft"` / `"google"`.
- Dead code removed: `syncLocalMail` (interface and both providers) plus
  `utils/email/local-mail-sync{,-types,-budget}.ts`,
  `utils/gmail/local-mail-sync.ts`, `utils/outlook/local-mail-sync.ts`,
  `utils/actions/local-mail-sync.validation.ts` and their tests — 3,372 lines
  with no production caller. `localMailSyncStrategy` stays; `source.ts` reads it.

**Deviation to note: widening the root unions was deferred, deliberately.** P1
needs no widening (a Nylas-backed Google account keeps `provider: "google"`), and
widening now would ship registry entries, rate-limit metadata, and engine CHECK
values for families that cannot yet be constructed. Each family's widening lands
with its implementation in P2; the `satisfies Record<ProviderFamily, …>` on the
definitions and the default-less switch in the factory turn that into a compile
error at that moment. The engine-side widening is already scoped to P2 in §6.3.

Evidence: `utils/email` + `utils/mail-api` + `/api/mail/v1` suites green (48 files,
681 tests); new `provider-registry.test.ts` (table-driven capability answers,
transport validity, unknown-provider fallback), `account-transport.test.ts`
(stored/unknown/missing values), and factory tests for an unknown family and an
unimplemented transport. Full non-AI suite run to confirm no wider fallout.

### P1 — Nylas transport for Google mail — IN PROGRESS

Landed so far:

- **Config**: `NYLAS_API_KEY`, `NYLAS_CLIENT_ID`, `NYLAS_API_URI`,
  `NYLAS_WEBHOOK_SECRET` in `env.ts` / `.env.example` / `turbo.json`, all
  optional so the app boots without Nylas and only Google is affected.
- **Client** (`utils/nylas/client.ts`): v3 URL building, `Bearer` auth, 204 and
  empty-body handling, `Retry-After` honoured on 429 (seconds or HTTP date,
  capped), exponential backoff with jitter on 5xx, no retry on other 4xx, and
  `request_id` surfaced in errors.
- **Auth** (`utils/nylas/auth.ts`): hosted-auth URL pinned to `provider=google`
  with `access_type=online` (Nylas owns the Google tokens), code exchange to a
  grant id, and a grant lookup so the mailbox identity comes from Nylas rather
  than from a provider claim.
- **Linking**: `/api/nylas/linking/{auth-url,callback}` reuse the existing signed
  state, state cookie, email-OTP policy, Redis code dedupe, reconnect-target
  matching, and `handleAccountLinking` decision table. The account is written as
  `provider: "google"` + `providerAccountId: <grant id>` + `transport: "nylas"`
  with no provider tokens.
- **Provider** (`utils/email/nylas.ts`): `NylasMailProvider` implements the live
  sync/read/mutate/send path; the settings-backed methods, provider signatures,
  send-as, forwarding, and contacts are explicitly unavailable (C3); draft
  support is not built yet and throws rather than pretending.
- **Sync**: a `nylas` cursor variant (time window + page token) in
  `utils/email/mailbox-sync.ts`, plus a provider capability
  `deriveCatchUpCursorFromMessages` that finally moves Gmail's cursor
  reconstruction out of the shared adapter.
- **Webhook** (`app/api/nylas/webhook`): echoes `challenge` on GET for endpoint
  verification; on POST verifies `X-Nylas-Signature` as HMAC-SHA256 over the
  **raw** body, resolves the account by grant id, notifies the local engine, then
  defers to the shared `processHistoryItem` behind `validateWebhookAccount`
  (premium/AI/rules gating) and the per-message Redis lock.
- **Truncated notifications** (webhook follow-up): a `*.truncated` payload drops
  the object body, so the thread the message belongs to is read from the provider
  by id instead of being guessed as the message id. A message that is already
  gone (`message.deleted.truncated`) keeps the payload id as its fallback, and a
  payload that did keep `thread_id` costs no extra read. The flag that
  `describeNylasTrigger` already computed is now actually consumed.
- **Connect path** (P1 follow-up): the registry now owns both facts that used to
  be else-chains — `linkingEndpoint` and `label` per family — and
  `getAccountLinkingUrl` (`utils/account-linking.ts`) fetches the family's own
  route instead of `provider === "microsoft" ? "outlook" : "google"`. Google
  connect therefore starts at `/api/nylas/linking/auth-url` from every entry
  point (add account, permissions consent, compose contact reconnect, mail-engine
  reconnect banner). That route answers a legible `isKnownError` when Nylas is
  not configured rather than failing while building the URL.
- **Watch capability** (R7): `ProviderCapabilities` stays family-scoped, but
  `perAccountWatch` is declared per **transport** in `utils/email/provider-registry.ts`
  (`oauth` true; `nylas` false — one application-level webhook; `imap` false — our
  own poll), and `resolveMailTransport` is now the single place that picks a
  transport from a stored value plus family default. `watch-manager` skips a
  transport with no subscription **before** the token gate, so a Nylas account is
  neither reported as `Missing authentication tokens.` every hour nor given a
  synthetic expiration date that would trip the lapse email.
- **C1 tripwire**: `utils/auth-login-providers.test.ts` asserts that a
  Nylas-configured Google sign-in requests `IDENTITY_SCOPES` and no `gmail.*`
  scope, and that the fallback still requests `gmail.modify` while our own client
  is the transport. This is what fails if the scope rule silently regresses.

Remaining:

- **Deleting the direct Gmail path.** Still the largest open item, and the reason
  C1 is currently a switch rather than a structural fact: `utils/email/google.ts`,
  `/api/google/linking/*`, `/api/google/webhook`, and `GMAIL_SCOPES` on our own
  consent all still exist. Sign-in scopes and `shouldLinkEmailAccount` drop Gmail
  only while `hasNylasConfig()` is true (`utils/auth.ts`), so an instance without
  Nylas still connects Google the old way. Deletion is what removes that branch —
  audited and sized in **P1c** below, which is where its coupling, test blast
  radius, and what can be verified where are written down.
- **C3 UI entry points.** `canManageAutoArchive` is still `Boolean(senderEmail)`
  (`utils/mail/use-unsubscribe-sender.ts`), so auto-archive stays visible for a
  Google/Nylas mailbox and fails at the click on
  `NylasUnsupportedFeatureError`; `utils/senders/filters.ts` still branches on
  `provider.name`. Needs capability gating plus the user-visible copy and release
  notes.
- **Docs: done** (commit `docs: document the Nylas transport for Google mail`).
  `/hosting/nylas` covers what Nylas owns, the four variables, the grant-id
  connection, what is disabled, and sync without a change log; the environment
  reference gained the `NYLAS_*` rows plus the rule that those variables — not a
  separate switch — are what put Google mail on Nylas; `google-oauth` and
  `google-pubsub` now point at that path instead of implying the direct client is
  the only option.
- **CI placeholder credentials: not needed, and the reason is worth keeping.**
  Every test that exercises the Nylas path stubs `NYLAS_API_KEY`/`NYLAS_API_URI`
  in a `vi.hoisted` block for the duration of that file, and no emulated
  (Playwright) flow uses Nylas yet — the emulated Google suites drive sign-in and
  the direct client. Adding placeholders to the workflows would configure Nylas
  for the whole run and change which transport those suites exercise. Revisit only
  if an emulated Nylas flow is introduced.
- **The emulator seed, the Playwright config, and the CLI's Pub/Sub setup are not
  drift yet.** They register the *direct* Google linking callback and topic, which
  is exactly what still runs for the emulated suites and for deployments without
  Nylas. They change with the deletion, not before it.
- **A live end-to-end pass** on a real Google grant (see Evidence).

**Deviation (integration harness)**: this document proposed MSW handlers plus a
`nylas` service entry in `emulate.config.yaml`. `@inbox-zero/emulate` has no Nylas
service — its `SERVICE_NAME_LIST` is a fixed set that stops at Google, Microsoft,
Slack, and other SaaS APIs — so the mocked Nylas API lives at the `fetch` boundary
instead, in `__tests__/integration/nylas-mailbox-transport.test.ts`. That is the
same seam the Outlook harness already rewrites, needs no new dependency, and
covers the sync/mutate contract; what it does not cover is the hosted-auth
handshake and webhook delivery, which the live pass (below) is for. A custom
`defineEmulator` service remains available if those ever need to run locally.

**Deviation from this section's wording**: notifications go to the shared
`processHistoryItem` rather than through the `processProviderHistory`
dispatcher. That dispatcher translates a provider's *change feed* into item
events; Nylas delivers the item itself (grant + message id), so routing through
it would add a branch that only ever reaches the same call.

Not blocked by the add-on purchase, and not blocked by the pending A-vs-B
development question in §4.7: the Nylas client, linking pair, provider
implementation, and webhook verification are all built and tested against a
mocked Nylas API. Only the first *live* Google handshake depends on either the
add-on or option A. Buy the add-on before the first external Google user, not
before coding.

Work: env + docs + CI dummies; Nylas client; linking pair; `EmailProvider`
implementation behind `transport: "nylas"`; app webhook with challenge and
signature verification; `process-history` branch; rate-limit metadata; watch
capability; **and deletion of the direct Gmail mail path** — `utils/email/google.ts`,
the Gmail linking routes, the Pub/Sub webhook, and `GMAIL_SCOPES` from our own
consent. No dual-transport window, no reconnect flow for a legacy Google
transport (confirmed: no existing Google accounts, §4.5). Include a pre-launch
checklist item to flip the production connector to the Shared App and reconcile
its scope list.

Rate-limit metadata needs no separate entry yet: a Nylas-backed Google account
keeps the family value `google`, so the existing `satisfies
Record<ProviderFamily, …>` still covers it, and Nylas' own 429 handling lives in
the client. Widening the root unions (and with them the engine CHECK) stays in P2.

Deleting the direct path is also what makes C1 structural rather than a promise:
with no code that can request a Gmail scope, the CASA proxy cannot silently
lapse. Keep the scope assertion test anyway (below) as the tripwire.

Plus the disabling work from C3: the settings-backed provider methods return
empty, and the features that depended on them (Gmail server-side filters in
`utils/senders/filters.ts`, the compose alias picker, provider-signature sourcing
in `utils/email/compose-signature.ts`) are turned off for Google accounts rather
than reimplemented. Disabling is user-visible, so it needs copy and release notes,
not just an early return.

Landed so far, and the deliberate shape of it: the read-only surfaces report
unavailable **by returning empty** (`getFiltersList`, `getSendAsAddresses`,
`getSignatures`, `getForwardingAddresses`, `getContactPhotos`, `searchContacts`),
and the surfaces that would have to *write* something raise
`NylasUnsupportedFeatureError`, which is now a `SafeError`. That distinction
matters at the user: the server-action layer (`utils/actions/safe-action.ts`)
returns a `SafeError`'s message to the user and only logs it, while any other
error becomes "an unexpected error occurred" **and** an exception report. Before
this, a Google user who pressed auto-archive on a sender got a generic failure and
a Sentry entry; the sender status is still recorded first
(`setSenderStatusWithAutoArchive` writes it before touching the provider), so the
accurate message is the honest outcome rather than a silent no-op — the provider
filter *is* the archiving, so skipping the write would have claimed a behaviour
that does not happen.

**Not done, and deliberately not faked: a capability query on the provider.**
Gating the *affordance* needs a server-side fact the client can read, but the
only consumers are UI call sites, and the same change decides user-visible copy.
Rather than add an unused `unsupportedFeatures` field now, that belongs with the
UI gate below, where it has a reader.

**Gate the WIP was silently failing: `pnpm check`.** The Nylas provider carried
five lint errors (an unused import, an unused `FOLDER_ROLES` constant, an unused
private `emailAccountId`, a `void ownerEmail` that existed only to quiet the
linter, and two `return undefined`) plus formatting the formatter would rewrite —
so CI's lint step would have failed on this work. All fixed; every file this
workstream touches now passes `biome check` (lint, format, import order). Worth
remembering that the tests being green says nothing about this gate.

Evidence. Landed: webhook tests for challenge echo, bad-signature rejection, and
duplicate delivery; the C1 scope assertion above; a watch-skip case proving a
Nylas account produces no result and no token failure; registry coverage for
transport resolution, the per-transport watch answer, and the linking endpoint;
and an integration test over a mocked Nylas API
(`__tests__/integration/nylas-mailbox-transport.test.ts`, gated on
`RUN_INTEGRATION_TESTS`, which CI sets) that walks bootstrap → delta → hydrate →
mutate and pins the load-bearing details: the two-minute window overlap, the
granter-keyed auth header, the page token holding the window open, the
read-modify-write that must send the whole folder set, and the flag patch that
must not. Also a route test for the webhook
(`app/api/nylas/webhook/route.test.ts`): challenge echo, fail-closed without a
secret, tampered and missing signatures, unrouteable payloads, the unknown-grant
and already-processing skips, `grant.expired` refreshing the engine without
running rules, the account-validation gate, and the three truncated-notification
outcomes. Also the C3 degradation contract: each disabled capability reports
unavailable — empty results where the answer can be "nothing", and a `SafeError`
(shown to the user, not reported as a fault) where the operation would have to
write something. Outstanding: hiding the affordances themselves for a Google
mailbox (the C3 UI gate, which also needs its copy and release notes) and a
`provider`-level capability query to drive it; plus a manual end-to-end pass on a
live Google grant — on a dev connector (option A) if Nylas allows one before the
add-on, otherwise at the Shared App switch — covering hosted auth, webhook
delivery, and an expired grant.

### P1b — Calendar and Contacts onto Nylas (~4–6 weeks, parallelizable)

Nylas Contacts behind the existing contact seam; a Nylas calendar provider behind
`utils/calendar/event-provider.ts` and the availability providers; `CalendarConnection`
re-plumbed to a grant id for Google (or retired in favour of the mail grant);
free/busy via Nylas' `/calendars/free-busy`; Drive-backed filing disabled for
Google accounts and the UI adjusted accordingly.

Evidence: calendar read/write and free/busy integration tests against a mocked
Nylas API; availability and booking regression tests proving Google results are
unchanged; a test that Google accounts no longer request Drive or Calendar scopes
on our own client; filing UI verified hidden (not broken) for Google accounts.

**Contacts: landed.** `utils/nylas/contacts.ts` implements both halves of the seam
that `GmailProvider` filled from the People API, and `NylasMailProvider` now
delegates to them instead of returning `[]`/`{}`:

- `searchContacts` sends the query as `search_query_native` untouched — the same
  pass-through contract as mail search, because re-implementing the provider's
  query syntax here would silently change what users' searches match. Results are
  mapped to `EmailContact` (display name, else given+surname, else company name)
  and run through the shared `normalizeContactCandidates`, so the picker cap,
  invalid-address filtering and de-duplication stay identical across transports.
- `getContactPhotos` walks paged contacts and keys photos by canonical address,
  bounded by the same 2,000-entry cap as the Gmail implementation.

Two decisions worth keeping:

- **A 403 means "this grant has no contacts scope", and the two paths treat it
  differently on purpose.** For search it yields no suggestions — compose still
  works and the user can type an address. For photos it is *re-thrown*, because
  the photos route caches a successful empty map for 24 hours as "this account
  has no photos"; swallowing a 403 would pin that on a grant that is merely
  unpermitted. Letting it through routes it to the existing 15-minute
  failed-sweep cache, which is what that cache was built for.
- **No "other contacts" source to merge.** `GmailProvider` had to union saved
  contacts with Other Contacts to get Gmail-like suggestions; for a Google grant
  the provider decides which address books a contacts read covers, so one walk is
  the whole address book.

Covered by `utils/nylas/contacts.test.ts` (11 tests: query pass-through, name
resolution order, several addresses per contact, invalid-address and duplicate
handling, the picker cap, the 403 split, canonical photo keys, first-photo-wins,
cursor paging) and `__tests__/integration/nylas-contacts.test.ts` (5 tests driving
both methods through `NylasMailProvider` over the fake API). The fake grew a
`/contacts` endpoint with `search_query_native` narrowing and `page_token` paging,
plus a `contacts` seed on `createNylasTestHarness`.

**Calendar: the transport and provider are landed; the connection is not yet created.**

`CalendarConnection` gained `transport` ("oauth" | "nylas", defaulting to "oauth")
and a nullable `grantId`, mirroring `Account` — migration
`20261018190000_add_calendar_connection_transport`. A Nylas connection keeps
`provider: "google"` (the family) and stores no tokens, so everything keyed on the
family — `getProviderAlignedLocationType` and its Google Meet mapping, the
invitations provider filter — keeps working unchanged.

- `utils/nylas/calendar.ts` is the transport: calendars, events (list, list by
  attendee, get, create, update, delete), `send-rsvp`, and free/busy.
- `NylasCalendarEventProvider` implements the whole surface the factory's union
  requires, including `findInvitationEvent` and `respondToInvitation`. That was
  not optional: `event-writer.ts` and `invitations/service.ts` call those methods
  on the union, so a read-only class would not have compiled.
- `createNylasAvailabilityProvider` serves free/busy, and
  `createCalendarEventProvider`, `isUsableCalendarConnection`,
  `hasUsableCalendarConnection` and `getUnifiedCalendarAvailability` all branch on
  **transport before family**.

Three decisions worth keeping, all from the Nylas reference rather than taste:

- **Invitation responses are translated, not passed through.** Nylas answers
  `yes` | `no` | `maybe` | `noreply`; the invitation buttons in
  `CalendarInvitation.tsx` set `aria-pressed` by comparing against Google's
  `accepted` | `declined` | `tentative`. Passing Nylas' words through would leave
  every button unhighlighted for a Nylas account.
- **The iCal UID lookup sends no `calendar_id`,** even though Nylas documents
  `calendar_id` as required on that endpoint and documents `ical_uid` as
  exclusive of every other filter. The two statements contradict each other; the
  UID alone is sent, because naming a calendar would mean guessing which one the
  invitation landed on.
- **`isOrganizer` is inferred from the address.** Nylas exposes no "this is you"
  flag for a Google grant (`is_owner` is Agent Accounts only), so it compares the
  organizer's address with the connection's own. Nylas documents that on a primary
  Google calendar the organizer address *is* the calendar id, which is what makes
  the inference reasonable rather than invented — but it is an inference.

**Two latent bugs found while wiring this, both the same shape as the watch job's
R7 fix** — a token check standing in for a transport check:

- `invitations/service.ts` skipped every connection without a `refreshToken`, and
  `event-provider.ts`'s usable-connection check did the same. A Nylas connection
  has a grant instead, so both would have silently ignored every Google calendar
  on that transport: the invitation flow would have emailed the organizer rather
  than updating the calendar, and the chat tool would have reported no calendar.
- `getUnifiedCalendarAvailability` grouped by provider family, so a Nylas Google
  connection would have been handed to the Google client with null tokens.

Deliberate reductions reported rather than hidden:

- **Free/busy is per address, not per calendar.** Nylas returns the blocks on an
  address's *primary* calendar, so a connection's secondary calendars cannot be
  included even when they are enabled locally. The direct Google path can include
  them. This is a real narrowing of availability for a Google user with a second
  calendar.
- **No invitation staleness check.** Google exposes a `sequence` and Microsoft
  carries it in an extended property; Nylas returns no revision, so an invitation
  that changed after the response was written cannot be detected. The response is
  applied to the event's current state.
- **`primary` as a calendar id needs the wider scope.** Reads use
  `calendar_id=primary`, which Nylas documents as requiring
  `.../auth/calendar` rather than the narrower `calendar.events*` scopes.

Covered by `utils/nylas/calendar.test.ts` (17), `nylas-events.test.ts` (25),
`nylas-availability.test.ts` (11), `event-provider.test.ts` (6) and a case added
to `invitations/service.test.ts` — 211 tests across `utils/calendar`, all green.

**Activation: connecting the mailbox is what connects the calendar** (decided, not
assumed — this was the open product question, and the answer is "no second
consent step"). `utils/calendar/nylas-connection.ts` gives every Nylas Google
mailbox a calendar connection and syncs its calendars, and the Nylas linking
callback calls it in its own `after()` alongside `ensureEmailAccountsWatched`.

- It is idempotent and converts in place: the unique key is
  (emailAccountId, provider, email), so a connection the direct Google flow
  created is re-pointed at the grant rather than duplicated.
- A grant whose connector has no calendar scopes answers 403, and that is
  treated as a missing feature: **no connection row is written at all**, so the
  calendar features stay absent instead of appearing and then failing.
- One mailbox failing is logged and skipped rather than propagated — the user is
  waiting on a redirect, so a calendar problem must not read as a failed linking.

Covered by `utils/calendar/nylas-connection.test.ts` (10 tests: the upsert shape,
in-place relink, unnamed calendars, cursor paging, timezone seeding, the 403 path,
a non-403 failure surfacing, multi-mailbox connect, skipping unusable accounts,
and continuing past a failing mailbox).

**What remains in P1b calendar:** the calendar/events endpoints in the Nylas test
fake (the calendar path is covered by unit tests but not yet by an integration
test through `createNylasTestHarness`), the Drive-backed filing UI gate, and the
scope assertion that our own client stops asking for the calendar and Drive
scopes.

### P1c — Deleting the direct Gmail path (audited, not started)

Measured so the deletion is mechanical when it happens. Nothing here has been
removed yet; the point of the section is that the cost is not where it looks.

- **Code to delete together, because each piece supports the others.** The
  transport branch in `utils/email/provider.ts` (family `google` + transport
  `oauth`), `utils/email/google.ts` (2,215 lines) with `google.test.ts` (1,289),
  `/api/google/linking/{auth-url,callback}`, `/api/google/webhook`,
  `validate-webhook-account.ts`'s `GmailProvider` import and its
  `provider: "google"` lookup, and `GMAIL_SCOPES` on our own consent in
  `utils/auth.ts` — where `shouldLinkEmailAccount("google")` becomes
  unconditional rather than dependent on `hasNylasConfig()`. Deleting a subset
  (for example the webhook alone) leaves a working transport with no push, which
  is worse than either end state.
- **The `utils/gmail/**` tree stays until P1b.** 65 files / 10,234 lines, of which
  the mail half is what P1c retires: `utils/calendar/client.ts` and
  `app/api/google/calendar/auth-url/route.ts` still read
  `utils/gmail/scopes.ts`, and `app/api/google/{calendar,drive}/*` are live.
- **The real cost is the test surface, not the provider.** 24 files reach the
  Gmail transport through `createGmailTestHarness`/`GmailProvider` (12 under
  `__tests__/integration` including the mail-engine set, 2 under `__tests__/e2e`,
  plus helpers), and `/api/google/webhook` is referenced by an emulated Playwright
  spec (`assistant-catch-up.spec.ts`), `utils/middleware.test.ts`,
  `utils/webhook/error-handler.test.ts`, and `packages/cli`'s Pub/Sub setup.
  Several of those tests are provider-agnostic in intent — draft creation, thread
  fetching, labeling/archiving, provider operations, rule execution — and should
  be retargeted rather than deleted; the fetch-boundary fake in
  `__tests__/integration/nylas-mailbox-transport.test.ts` is the pattern.
- **Coverage that would shrink, and needs a decision.** The Gmail transport is the
  only local coverage of Gmail-shaped semantics — `historyId` cursors and the
  Pub/Sub change feed. Nylas has no change log and its API is mocked here, so
  without retargeting the harness those behaviours lose their only real-execution
  home.
- **Outside `apps/web`**: `emulate.config.yaml`, `apps/web/scripts/emulate-seed.ts`
  and `playwright.config.mjs` register the direct linking callback;
  `packages/cli` provisions the Pub/Sub topic (`setup-google.ts`,
  `google-pubsub*`, `main.ts`); `docs/hosting/google-{oauth,pubsub}.mdx` document
  it.
- **Verification, measured rather than assumed.** `pnpm test-integration` *does*
  run in a plain Windows session — the emulator is in-process — so the integration
  half of P1c (12 of the 24 files) is verifiable locally: measured at 40 files /
  203 tests green. The Gmail **e2e** suites are not, because they need a seeded
  database (without one they fail with `PrismaClientValidationError`), and the
  **emulated Playwright** suite is not, because its runner dies at
  `spawnSync pnpm.cmd EINVAL` on this host. So retargeting the integration files
  can be driven to green here; the two e2e files and the emulated spec need CI.
- **Landed (retargeting complete)**: `createNylasTestHarness` sits in
  `__tests__/integration/helpers.ts` next to the Gmail and Outlook harnesses —
  a fake Nylas v3 API at the `fetch` boundary, seeded with messages, exposing the
  mailbox and every request made, plus a guard that fails loudly when
  `NYLAS_API_KEY`/`NYLAS_API_URI` were not stubbed in a `vi.hoisted` block before
  `@/env` was evaluated.
  All four mail-engine arms are now retargeted and verified against the
  integration suite: `archive-reconciliation` (bootstrap → enumerate → archive →
  reconcile, asserting on provider-side folder state), `catch-up` (an external
  archive that only surfaces by re-reading the window, plus a second pass proving
  it is not re-added — and the Gmail-specific fetch rewrite it used to mutate the
  mailbox through the emulator's own client is gone), `http-archive` (the same
  slice driven through the real `/api/mail/v1` routes) and `search-body` (body
  hydration, a local-text search, a read-state change, and reopening the SQLite
  file). Three needed no fake growth at all, for a structural reason: the source
  is account-history, so `discoverScopes` makes no folder call and enumerate
  passes no `inboxOnly`.
  The fourth needed one, and it is worth recording how it was found: this
  document first claimed `search-body` needed `search_query_native` term matching
  *because its assertion was vacuous*. Reading it showed the search itself is a
  local predicate over hydrated bodies — the provider's only job there is
  hydration — but the `/search` route *is* dispatched and the provider does send
  `search_query_native`, so the fake would have answered a search with the whole
  mailbox. So the fake now filters on a plain term, and the arm's assertion was
  tightened from "at least one hit" to exactly one, which is what makes it a test
  rather than a smoke check.
  `nylas-mailbox-transport.test.ts` was rewritten onto the harness, so the fake
  has two consumers and no duplicate copy.
  The fifth retarget is `provider-operations`, the broadest provider-surface
  suite (it runs one shared factory against both providers: pagination, the label
  lifecycle, thread read/archive, label application, and a 100-message bulk
  archive). This is the first retarget that **did** need fake growth, and it is
  the case the earlier "grow it when a consumer needs it" rule was waiting for:
  `GET`/`POST /grants/{id}/folders` for `getLabels`/`createLabel`/`getLabelByName`,
  `thread_id` filtering on the message list so `markReadThread`/`archiveThread`
  touch one thread instead of the mailbox, and the label list exposed on the
  harness (`labels`) so a test can assert a created label. The shared factory also
  stopped demanding an `emulator` it never used, which is what lets a fetch-level
  fake drive it at all.
  The sixth is `thread-fetching`, and it is a different kind of retarget worth
  recording: half of it did not test the provider at all — it called
  `utils/gmail/thread.ts` wrappers (`getThread`, `getThreadsWithNextPageToken`)
  against the Gmail client, which have no Nylas equivalent because thread reads
  belong to the provider interface. Those go with the tree. In their place the
  file now covers the provider's thread reads, which nothing covered before:
  `getThread` and `getThreadMessages` against a thread that actually holds two
  messages (the old seeds gave every message its own thread, so membership was
  never really exercised). Net one test fewer, and the coverage it has is real
  rather than incidental. Zero fake growth: the `thread_id` filter was already
  there for `provider-operations`.
  The seventh is `rule-execution`, the first retarget that is about the
  *automation pipeline* rather than the provider surface: it drives `executeAct`
  (the rule action executor) over a Nylas mailbox and checks that LABEL creates
  and applies, ARCHIVE clears INBOX on the thread, MARK_READ clears UNREAD, and
  LABEL + ARCHIVE together do both — with the read-back going through the provider
  so the label derivation is exercised. Zero fake growth again, because the
  folders and `thread_id` work from `provider-operations` already covers the
  actions.
  The eighth is `webhook-flow`, which walks `processHistoryItem` end to end on a
  Nylas mailbox: an inbound message is fetched, handed to rule matching, and its
  LABEL + ARCHIVE land on the provider; an outbound message routes to outbound
  handling with no rules; a duplicate delivery is skipped; no AI access means no
  action; MARK_READ clears UNREAD. No fake growth. One detail is worth keeping:
  assertions read label state **through the provider**, not from the fake's stored
  folders, because a flag change patches `unread` without rewriting the folder
  list — reading the raw mailbox would show a stale `UNREAD`.
  The remaining retargets, all verified against the integration suite:
  `labeling-archiving` became round-trip coverage (unread again, label removed,
  unarchived, label deleted, starred) because the wrapper tests only ever checked
  one direction; `webhook-action` (CALL_WEBHOOK delivery + LABEL),
  `stats-reuse-messages` (saving paginated rows without a per-message re-fetch,
  now asserted by "no single-message GET was made" instead of a Gmail `/batch/`
  URL), `run-rules-learned-exclusions` (learned-pattern exclusions before AI),
  `shared-conversations` (a 25-message thread plus a changed-recipient branch,
  with draft and unrelated mail excluded), `reply-context-search-thread-precedent`
  (thread expansion + current-thread exclusion over a real search),
  `demo-inbox-fixture` (a new `toNylasSeedMessages` adapter, plus an assertion
  that a Gmail-style operator reaches Nylas **untouched** in
  `search_query_native` — that pass-through, not a local re-implementation, is
  what keeps users' rule queries working), `draft-creation` (reply draft lands on
  the original's thread; send removes it from drafts, adds SENT, and keeps the
  edited body), `todoist-integration-action`, and the Slack draft-send flow inside
  `slack-notifications`.
  `mailbox-change-push` moved from the Google Pub/Sub webhook to a **signed Nylas
  webhook** (`message.created` → one silent push per device → cooldown suppresses
  the repeat, and the desktop `mail-change` stream still fires), which is the path
  that survives the deletion step.
  **Fake growth over the whole phase**, all driven by a consumer: `GET`/`POST`/
  `DELETE` on folders, drafts (`POST /drafts`, `POST /drafts/{id}` to send,
  `PUT`, `DELETE`), `in` folder filtering, `thread_id` filtering, plain-term
  search, bodies present in list responses (Nylas trims headers with `fields`,
  not the body), and pass-through for any origin that is not the fake — which is
  what lets a test run the fake next to the Slack and MCP emulators.
  **One product bug was found by the retarget**: `getDraft` returned any message
  by id, so a draft that had already been sent still looked present
  (`Gmail` 404s there). It now returns null unless the message is still in the
  drafts folder.
  **Final state**: every integration test that used the Gmail harness now runs on
  Nylas except two, and those two are **deletion candidates, not retargets**:
  `gmail-mailbox-history` (Gmail's `historyId` cursor and its expiry — Nylas has
  no change log) and `draft-attachments` (Gmail's resumable draft-attachment
  upload protocol, which `NylasMailProvider` deliberately reports as unsupported
  and which a unit test already pins). They keep `createGmailTestHarness` in
  `__tests__/integration/helpers.ts` alive until the transport itself is deleted.
  The 2 Gmail e2e files are a different shape again — they construct
  `GmailProvider` directly rather than through the harness — so they belong to the
  deletion step, not the retargeting one.
- **Sequencing**: P1c wants P1b first (or an explicitly scoped mail-only deletion
  that keeps the `utils/gmail/**` tree), and it is one coordinated change, not two
  — deleting the transport while calendar and contacts still borrow its scopes
  module, or the webhook while the transport still relies on it, leaves the tree
  in a state neither end of the migration wants.
- **What remains once the retargeting is done**: the deletion itself (the code
  list above, plus the two deletion-candidate test files and the Gmail harness
  they hold open), the 2 Gmail e2e files, and the outside-`apps/web` drift
  (`emulate.config.yaml`, the emulator seed, the Playwright config, the CLI's
  Pub/Sub setup, and the hosting docs). None of it is test work — the test surface
  is now on the transport that remains.

### P2 — IMAP/SMTP + direct OAuth providers (~6–8 weeks)

`MailboxCredential` + encryption; IMAP client, MIME mapping, folder-delta cursor,
SMTP send; the generic provider; the credentials form with provider presets;
Yahoo/Zoho providers; generalize the adapter's folder-delta branches; the
polling path for server-side automation (G6); engine enum/CHECK widening.

Evidence: IMAP provider conformance suite against a local IMAP server covering
UIDVALIDITY change → `reset_required`, flag round-trips, folder roles, attachment
streaming, and SMTP send; an end-to-end connect-with-app-password flow; a test
proving a poll-only account no longer produces hourly watch errors or lapse
emails; a bounded-poll run showing new mail reaches the rules pipeline.

### P3 — Product surface (~1.5–2 weeks)

Registry-driven `AddAccount`, provider logos and copy, accounts-page error
strings, connect-mailbox copy, terminology from capabilities, mobile/desktop
provider unions, hosting docs and CLI setup prompts.

Evidence: Playwright coverage of the connect flows per provider, screenshots
reviewed per `AGENTS.md`, and `docs/hosting` updated so self-hosters can
configure each provider.

Sequencing note: P0 must land before P1 because the registry/`transport`
indirection is what the Nylas implementation plugs into. P1b (calendar and
contacts) can run in parallel with P1 by a second engineer once P0 is in. P2's
engine enum widening is independent of P1 and could also run in parallel.

<a id="gates"></a>

## 9. Decision gates

G1 does **not** block P1 — development runs against a mocked Nylas API (§4.7). It
blocks the *launch of Google* to real users. G6 shapes P2. G2 and G3 are resolved.

- **G1 — Nylas add-on purchase and consent branding (launch gate, not a dev
  gate).** CASA itself is settled: Nylas proxies it, so no assessment is ours to
  run. What is decided so far: buy at launch, build now against a mocked Nylas API
  (§4.7). First action is a question to Nylas support — whether a
  development/staging application can use the Shared App before the add-on, which
  decides between options A and B and may remove GCP from this plan entirely (§4.7
  lists the five questions). Still needing an owner and a date: the annual Pro plan
  plus Accelerator add-on (or the Enterprise add-on) must be on the plan **before the
  first external user connects Google**, because the alternative for real users is
  our own CASA. Also confirm that users seeing "Nylas" rather than our brand on
  the consent screen is acceptable; white-labeling would require our own Cloud
  project and our own CASA — the one option this design rejects.
- **G2 — RESOLVED: Google goes wholly through Nylas; what Nylas lacks is
  disabled.** Settled by product decision. Mail, Calendar, and Contacts move to
  Nylas (§4.6, §8 P1b); Gmail server-side filters, send-as alias enumeration,
  provider signatures, forwarding addresses, and Drive are disabled for Google
  accounts (C3). Two residual points to acknowledge at implementation time, not
  to re-decide: document filing becomes Microsoft-only, and Gmail-configured
  filters/aliases/signatures stop being reflected. If the Drive asymmetry is
  later judged untenable, the only CASA-safe reversal is keeping `drive.file` on
  our own client — which contradicts this rule and so needs an explicit
  reopening.
- **G3 — RESOLVED: retired.** No environment holds real Google accounts, so there
  is no migration window to plan. The direct Gmail path is deleted in P1 (§4.5)
  rather than coexisted. Reopening this gate requires a deliberate decision to
  expose Google to real users on our own Cloud project before the add-on is
  purchased — which carries its own CASA obligation and is therefore not a
  scheduling choice.
- **G4 — Zoho: REST Mail API or IMAP?** The REST API gives better folder/search
  fidelity; IMAP reuses one code path with Yahoo/Fastmail/iCloud. Pick per
  provider or standardize.
- **G5 — Retiring the dead `syncLocalMail` stack in P0.** Confirms we may delete
  rather than deprecate (it has no production caller).
- **G6 — Server-side automation for poll-only providers.** Cron polling
  (recommended) vs IMAP IDLE vs shipping those providers as UI-only with rules
  running only while the app is open. This is the biggest product decision in the
  plan.
- **G7 — Where IMAP secrets live.** Recommended: `MailboxCredential` with the
  existing encryption helper. Alternative: reuse the Prisma-extension-encrypted
  `Account` token columns, which is less code but conflates connection secrets
  with OAuth tokens.
- **G8 — Which providers are in the first IMAP release.** Recommended: generic
  IMAP + app-password presets for iCloud/Fastmail/163/QQ and corporate mail
  first, then OAuth-based Yahoo/Zoho. Generic IMAP covers the most mailboxes per
  unit of work.

<a id="risks"></a>

## 10. Risks

- **Nylas becomes a single point of failure for all Google access, not just
  mail.** Under the C2 rule, outages, rate limits, grant expiry, or a pricing
  change affect Google mail, calendar, and contacts together, and there is no
  fallback path by design — the direct Gmail code is deleted in P1, and no
  existing users are stranded by that (§4.5). Mitigation: surface grant-health
  errors distinctly from Gmail rate limits, make `grant.expired` a first-class
  reconnect flow rather than a generic error, and treat the add-on as
  availability-critical rather than a nice-to-have.
- **Google feature parity loss is permanent and visible.** Server-side filters,
  send-as aliases, provider signatures, and Drive-backed filing are disabled for
  Google only. Support burden and perceived parity risk are real; the UI must hide
  these affordances rather than let them fail, and release notes must state the
  change. This is the accepted cost of the C2 rule, not an oversight.
- **Drift between transport and family.** If any code infers the transport from
  `provider` or from the shape of `providerAccountId`, R9's overwrite bug
  returns. Mitigation: `transport` is the only discriminator; add a test that
  fails if a linking flow writes tokens for a `nylas` account.
- **Capability refactor incompleteness.** A single missed else-chain silently
  routes a new family into Microsoft behaviour (R5). Mitigation: make the
  capability lookup total over the registry (no default branch), and grep-proof
  the four predicate helpers so new call sites cannot be added by accident.
- **IMAP reality is messier than the interface.** Consumer providers differ on
  app passwords, IMAP enablement, folder naming, and flag semantics; corporate
  IMAP can be slow or restricted. Budget for per-provider quirks and keep the
  generic provider conservative.
- **Local-database migration risk.** The SQLite CHECK change touches data already
  on users' devices (OPFS and desktop). A botched migration could look like data
  loss. Needs a migration test with a real pre-existing database, not just a
  fresh one.
- **New dependencies.** `imapflow`, `mailparser`, and the Nylas SDK are new
  supply-chain surface; `nodemailer` already exists.

<a id="testing"></a>

## 11. Testing strategy

Follow the repo's existing split: co-located unit tests next to sources,
integration/E2E under `__tests__/`.

- **Unit**: registry and capability totality; transport selection; cursor
  encode/decode per sync source; MIME → `ParsedMessage` mapping; folder-role
  mapping; credential encryption round-trip; the linking decision table with a
  Nylas account.
- **Integration**: a mocked Nylas API for bootstrap/delta/hydrate/mutate and
  webhook signature and challenge handling; a local IMAP server for the provider
  conformance suite. Implemented at the `fetch` boundary rather than as an
  `emulate` service entry, because that package has no Nylas service (see the
  P1 deviation note); a local IMAP server is still ahead of us. The repo already
  emulates Google and Microsoft via `emulate.config.yaml`, and an IMAP emulator
  entry belongs there so the connect flows are testable locally.
- **End-to-end**: connect and reconnect per provider through Playwright,
  including the app-password form's failure states, and screenshots reviewed per
  `AGENTS.md`.
- **Migration**: an upgrade test that opens a pre-existing engine database,
  applies the CHECK/table-rebuild migration, and asserts existing local mail
  survives.

<a id="out-of-scope"></a>

## 12. Out of scope

- **No Drive for Google accounts.** Per C3 this is disabled, not migrated. The
  meeting recorder's Meet/Teams normalization and booking's Meet/Teams meeting
  links also stay as they are — they are not provider-API access and are unaffected
  by the scope rule.
- **Calendar and Contacts are IN scope for Google** (P1b). They move to Nylas
  because Nylas supports them. What is out of scope is doing so *at the same time
  as the mail transport*: P1b is a separate workstream and can land after P1.
- **No Nylas for non-Google providers.** Microsoft, Yahoo, Zoho, Fastmail, iCloud,
  and generic IMAP keep their own OAuth/IMAP transports per the instruction that
  shapes §1. The transport indirection would make Nylas-for-everything possible
  later, but it is not built now, and it would contradict the cost rationale.
- **No new mail-engine protocol, no changes to `mail-react` / `mail-ui`.**
- **No IMAP IDLE** unless G6 selects it.
- **No AI/prompt/tool changes.** If a capability refactor turns out to require
  touching assistant tool descriptions or the system prompt, that will be
  disclosed separately for approval rather than bundled here.
