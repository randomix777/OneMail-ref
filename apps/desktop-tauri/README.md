# OneMail desktop (Tauri + Rust)

The Rust replacement for `apps/desktop`. Same renderer bundle, same mail-engine
IPC contract (`@inboxzero/mail-core/protocol/mail-ipc`), no Electron.

## Run

```sh
pnpm --filter @inboxzero/desktop-tauri dev
```

`dev` first rebuilds the renderer with `apps/desktop/esbuild.config.mjs`, copies
it to `dist/ui`, and drops the document-level CSP (the same policy is sent as a
header from `tauri.conf.json`). The Electron preload is replaced by
`ui/init.js`, injected as a webview initialization script so it runs before the
renderer bundle; it rebuilds `window.inboxZeroDesktop` on Tauri IPC and shims the
Node `process` global the bundled dependencies expect.

## First run

The Tauri shell advertises `requiresJyiLogin`. Until a JYI connection is stored,
the window shows the JYI sign-in screen and the local mail UI is not mounted.
After the browser flow completes, the mail UI opens; disconnecting JYI in
Settings returns to the sign-in screen. Mailbox credentials and the local mirror
stay on disk throughout. The Electron local shell does not set this flag and
keeps its optional-JYI behavior.

## Layout

- `src-tauri/src/lib.rs` — commands, mail-engine dispatch, snapshot push.
- `src-tauri/src/sync.rs` — IMAP page → mirror → snapshot, in the background.
- `src-tauri/src/content.rs` — background body fetch for `ensureMessageContent`.
- `src-tauri/src/operations.rs` — queued executor: IMAP metadata writes and SMTP
  sends, with retries.
- `src-tauri/src/state.rs` — profile paths, settings persistence, store handle.
- `crates/mail-ipc` — protocol v1 types mirrored from TypeScript.
- `crates/mail-store` — SQLite mirror (rusqlite), revision fence, mailbox reads,
  drafts, operation queue.
- `crates/mail-imap` — implicit-TLS IMAP login, folder listing, page and body
  fetch, flag writes, moves, and Sent appends.
- `crates/mail-smtp` — SMTP submission over implicit TLS or STARTTLS, including
  the HTML MIME message builder.
- `crates/mail-vault` — account passwords in the OS keystore.

Profile files live in `%APPDATA%/OneMail` (macOS: `~/Library/Application Support/OneMail`):

- `settings.json` — accounts, servers, and, later, the AI connection summary.
- `local-mailbox.rust.sqlite` — the Rust mirror. Named separately from the
  Electron `local-mailbox.sqlite` on purpose: the schema port is incomplete, and
  two writers on one file would corrupt the profile mid-migration.

Passwords are not in either file: they are stored per account in the platform
keystore (Windows Credential Manager, macOS Keychain, Secret Service) under
`account:<accountId>.com.getinboxzero.desktop`.

## Ported so far

- Shell: window, Tauri IPC, protocol envelope validation, revision fence.
- `local:settings`, `local:account-save`, `local:account-remove`. A save verifies
  the IMAP login and the SMTP login before it changes the profile, then stores
  the password in the keystore and mirrors the first page.
- IMAP read sync: newest 50 messages of INBOX, Sent, Drafts, Archive, Trash and
  Spam, headers only, keyed on `UIDVALIDITY` per folder. Login supports implicit
  TLS and STARTTLS; STARTTLS credentials are only sent after the socket is
  upgraded. `requestSync` runs it in the background and pushes a fresh snapshot
  to every live subscription; the shell syncs on launch, keeps an INBOX IDLE
  watcher per account when the server advertises IDLE, and falls back to a
  60-second poll. Concurrent syncs of one account are collapsed into the running
  one.
  Gmail's All Mail is classified separately from Archive, so it is never
  mirrored and never used as an archive destination.
- `observeMailbox`, `observeMailboxWindow`, `observeMailboxCounts`, `requestSync`,
  `purgeAccount`, `retainAccounts` — answered from the local mirror.
- Predicates: the full protocol set compiles to SQL over the mirror — boolean
  `all`/`any`/`not`, role and well-known mailbox, read, starred, inbox section,
  folder/label/category membership, address, received window, has-attachment,
  message ids, and text. An unknown or malformed predicate reads as an empty
  view instead of an error.
  - Text search is a substring scan over subject, preview, sender, and the
    visible text of a stored body (`match: "term"` ANDs whitespace-separated
    words; `"phrase"` requires the whole string). The Electron store prefers an
    FTS5 index; the Rust mirror stores plain text, so bodies become searchable
    as soon as they are hydrated. This is linear in the mirrored rows and should
    be revisited if the mirror grows well beyond one page per folder.
  - Sync stores folder membership only, so `inbox_section`, label and category
    predicates compile but match nothing until those columns are populated.
- Message bodies and attachments:
  - `observeConversation` pages a thread oldest first from the mirror, joins the
    stored body, and reports `content.status` (`not_requested` / `available`).
  - `ensureMessageContent` answers `scheduled` and downloads the full message
    (`BODY.PEEK[]`) in the background, deduped per message and bounded to two
    concurrent connections. The parsed HTML, text, preview and attachment
    descriptors land in `message_content`; the revision fence advances so live
    subscribers receive the update.
  - `readAttachment` downloads the message again and returns the bytes of the
    requested part (the inline image path does this per `cid:`).
  - Full messages over 25 MB, bodies over `MAX_BODY_LENGTH`, and attachment
    lists over `MAX_BODY_ATTACHMENTS` are cut or refused the same way the
    Electron engine does. A body fetched under a different `UIDVALIDITY` is
    dropped instead of attached to the wrong message.
- Linkage: a new Rust-only `message_remote` table records each message's folder,
  `UIDVALIDITY` and UID, because message ids are RFC Message-IDs. A folder that
  changes `UIDVALIDITY` takes its bodies and coordinates with it.
- Metadata commands: `getDiagnostics`, `submitMetadata`, `submitConversations`,
  `observeOperation`, `cancelOperation`.
  - `archive`, `unarchive`, `set_read`, `set_starred`, `trash`,
    `restore_from_trash`, `set_spam` and `move` are supported. Label/category
    membership and `snooze` are rejected with `unsupported`, so they are never
    shown as applied.
  - Admission writes the change into the mirror immediately, records
    `pendingOperationIds` on each message, bumps the revision and pushes a
    snapshot. Retrying the same command id with the same intent answers
    `already_recorded`; the same id with different intent is `invalid`. A queue
    holds up to 500 pending commands per account, and conversation submissions
    reject only an epoch mismatch (`stale_selection`).
  - The executor sets `\Seen` / `\Flagged` with `UID STORE`, and archives, trashes,
    spams, unspams or restores by moving to the folder whose role is `Archive`,
    `Trash`, `Spam` or `Inbox`. `move` verifies that the requested folder path
    exists before moving; a missing folder fails with `no_destination` and
    reverts. Moves use `UID MOVE`, falling back to
    `COPY` + `\Deleted` + `UID EXPUNGE`. The destination UID is recovered with
    `UID SEARCH HEADER Message-ID`, then the message's folder and server
    coordinate are updated. If that search finds nothing, the coordinate is
    dropped; a body already stored stays readable, but the message can no longer
    be fetched or moved until the next sync re-learns it.
  - A queued `move` removes the Inbox role and records the destination folder
    immediately, matching the TypeScript effective-state rule. The destination
    role appears after the next sync of that folder, which the Rust mirror does
    not sync yet.
  - Connection, timeout and protocol failures retry after 2 s and 10 s, three
    attempts total. Auth, TLS, config and a missing destination folder fail
    permanently. A permanently failed or cancelled command reverts the message
    metadata to the values saved at admission and clears its pending id.
  - With no stored credential the command stays `queued` and the optimistic
    state stands. Queued commands resume on launch and after an account save
    stores a password.
  - Messages without a server coordinate (the seeded profile) are local-only:
    the command succeeds without a round trip.
  - Statuses are `queued`, `executing`, `retry_wait`, `succeeded`, `failed` and
    `cancelled`; sends can also become `uncertain`. `blocked_auth` is never
    produced. `getDiagnostics.connection` reflects whether a credential is
    stored, not a live connection probe, and `pendingJobs` is always 0. Finished
    commands keep their target rows as history.
  - Overlapping commands on one message are applied in order. If one fails, its
    metadata snapshot is restored without replaying the other pending commands,
    so a deliberately opposite change made in quick succession can show an
    intermediate value until the next sync.
- Compose and send: `saveDraft`, `readDraft`, `submitSend`.
  - Drafts are local rows in the Rust mirror. Saving requires the current
    `expectedRevision` (or `null` for a new draft) and returns `conflict`
    otherwise. A row is frozen at admission; failure and cancellation hand it
    back for editing, while a successful send leaves it frozen.
  - Admission copies the frozen draft content into the operation's intent JSON.
    Replaying the same `commandId` with the same draft revision answers
    `already_recorded`; different content under the same id is `invalid`.
    `notBeforeMs` becomes the operation's first attempt time, so deferred sends
    wait in the queue while the app is open.
  - The executor builds one HTML MIME message per operation: `Date`, `From`,
    `To`, `Cc`, a deterministic `Message-ID`, RFC 2047 subject, and a base64 HTML
    body. `Bcc` is an envelope recipient only and is not written into the header.
    SMTP auth uses `AUTH PLAIN` or `AUTH LOGIN` when advertised, over implicit
    TLS or STARTTLS. The same bytes are then `APPEND`ed to the folder whose role
    is `Sent`; a missing or refused Sent folder does not turn an accepted send
    into a failed operation.
  - Connect, timeout and pre-`DATA` network failures follow the metadata retry
    policy (three attempts, 2 s and 10 s). Auth, TLS, config and envelope
    rejections fail permanently. Once the `DATA` block has been written a
    failure is reported as `uncertain` and is never retried automatically;
    `executing` sends left behind by a crash are also marked `uncertain` at
    launch. On launch each uncertain send is looked up by its deterministic
    Message-ID in Sent: a hit becomes `succeeded`, otherwise it stays
    `uncertain`. Permanent failure, cancellation and uncertainty unfreeze the
    draft.
  - The compose dialog only exposes one body field and one HTML part, so the
    stored draft's `editableHtml` and `quotedHtml` are concatenated exactly as
    the TypeScript executor did.

- JYI AI: `local:ai-connect`, `refresh`, `disconnect`, `models` and `analyze`.
  - Sign-in uses authorization code + PKCE through the browser and the
    registered loopback callback `http://127.0.0.1:5000/oauth/callback`; the
    callback host and state are checked before the code is accepted. JYI permits
    another loopback port with the same host and path; set
    `ONEMAIL_JYI_REDIRECT_URI` to override the URI when needed.
  - The full connection (including the API key) lives in the OS keystore under
    `account:ai`; `settings.json` only ever receives the non-secret summary.
  - The identity and gateway origins are HTTPS-only and can be overridden with
    `ONEMAIL_JYI_AUTH_ORIGIN`, `ONEMAIL_JYI_GATEWAY_ORIGIN` and
    `ONEMAIL_JYI_CLIENT_ID`. A gateway or billing URL whose origin does not
    match the configured service is refused.
  - `models` reads `/v1/models`; `analyze` posts the selected messages to
    `/v1/chat/completions` with the same prompt and size limits as the Electron
    implementation, and maps 401/402/403 to the renderer's reconnect, balance
    and model messages.

- Desktop shell: one running instance (a second launch focuses the first), an app
  menu with Settings/Quit, and an OS notification when a manual or periodic sync
  finds more unread Inbox messages than the mirror had before. The launch sync
  does not notify about mail that was already there. Closing the window ends the
  process; there is no tray mode.

## Not ported yet

- The `inspect` and request-`cancel` protocol methods are not dispatched. The
  vendored renderer never calls them; mailbox diagnostics go through
  `getDiagnostics` instead.
- Server-side drafts: drafts live only in this profile and no IMAP `Drafts` copy
  is written or read. Provider draft ids are preserved in draft content but
  ignored.
- Send features beyond the compose form: attachments, signatures, rich-text
  editing and send-as authorization checks. `replyTo` resolves and stores the
  conversation id and adds `In-Reply-To`/`References` for the immediate parent;
  it does not build the full References chain. A deferred send is a persisted
  operation that resumes on the next launch; there is no OS-level scheduled-send
  job.
- IMAP coverage: custom folders are not mirrored. IDLE is used when the server
  advertises it; otherwise accounts fall back to the 60-second poll. Archived,
  trashed and restored messages are updated locally, and
  Archive/Trash/Spam/Drafts are refreshed on the next change or poll.
- Archive means "move to an `Archive`-role folder". Gmail's
  archive-as-label-removal is not implemented, so an account without an Archive
  folder fails the command with `no_archive` instead of guessing.
- The metadata operation authority is simplified: there is no `uncertain`
  reconciliation after an ambiguous move failure, so a `MOVE` that the server
  applied before the connection dropped can be retried as a copy.
- Tray and auto-update. Auto-update needs a signed release feed and signing
  keys, which this repository does not provide yet.
- Opaque pagination cursors: `observeMailboxWindow` grows the first page
  (`pageSize * pageCount`) instead of resuming from a cursor, and
  `nextPage` stays `null`.
- Full migration parity: `crates/mail-store` creates the subset of DDL it reads.
- Body storage is plain text, not the TS body codec, and attachment bytes are
  never cached locally (parity with the Electron engine's on-demand download).
- The desktop renderer shows inline images but has no attachment download list;
  `readAttachment` is only reachable through the `cid:` path today.

## Verify

```sh
pnpm --filter @inboxzero/desktop-tauri test   # cargo test
pnpm --filter @inboxzero/desktop-tauri build  # cargo build + UI bundle
```
