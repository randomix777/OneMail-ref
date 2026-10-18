/**
 * Shared helpers for integration tests using @inbox-zero/emulate.
 *
 * Eliminates boilerplate: emulator creation, OAuth/client setup,
 * provider instantiation, and thread ID resolution for both
 * Gmail and Outlook.
 */

import { createEmulator, type Emulator } from "emulate";
import { gmail, auth } from "@googleapis/gmail";
import { Client } from "@microsoft/microsoft-graph-client";
import { WebClient } from "@slack/web-api";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { createTestLogger } from "@/__tests__/helpers";
import { GmailProvider } from "@/utils/email/google";
import { NylasMailProvider } from "@/utils/email/nylas";
import { OutlookProvider } from "@/utils/email/microsoft";
import { OutlookClient } from "@/utils/outlook/client";
import type { EmailProvider } from "@/utils/email/types";

type GmailSeedMessage = {
  id: string;
  user_email: string;
  thread_id?: string;
  message_id?: string;
  references?: string;
  in_reply_to?: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  reply_to?: string;
  subject: string;
  body_text: string;
  body_html?: string;
  snippet?: string;
  label_ids: string[];
  internal_date: string;
  date?: string;
};

type OutlookSeedMessage = {
  id?: string;
  microsoft_id?: string;
  conversation_id?: string;
  internet_message_id?: string;
  user_email: string;
  from: { address: string; name?: string };
  to_recipients: Array<{ address: string; name?: string }>;
  cc_recipients?: Array<{ address: string; name?: string }>;
  subject: string;
  body_content: string;
  body_content_type?: "html" | "text";
  body_text_content?: string;
  parent_folder_id: string;
  is_read: boolean;
  is_draft?: boolean;
  categories?: string[];
  received_date_time: string;
  sent_date_time?: string;
};

type SlackSeedUser = {
  name: string;
  real_name?: string;
  email?: string;
  is_admin?: boolean;
};

type SlackSeedChannel = {
  name: string;
  is_private?: boolean;
  topic?: string;
  purpose?: string;
};

export type GmailTestHarness = {
  emulator: Emulator;
  gmailClient: ReturnType<typeof gmail>;
  provider: GmailProvider;
  /** Map of seed message ID → emulator-assigned thread ID */
  threadIds: Record<string, string>;
};

export type OutlookTestHarness = {
  emulator: Emulator;
  graphClient: Client;
  provider: OutlookProvider;
  /** Call in afterAll to restore globalThis.fetch */
  restoreFetch: () => void;
};

export type SlackTestHarness = {
  emulator: Emulator;
  client: WebClient;
  teamId: string;
  channelsByName: Record<string, string>;
  usersByName: Record<string, string>;
};

/** Common harness shape for provider-agnostic tests */
export type ProviderTestHarness = {
  emulator: Emulator;
  provider: EmailProvider;
  email: string;
};

/**
 * Creates a fully wired Gmail test environment:
 * emulator + OAuth client + Gmail client + GmailProvider + thread ID map.
 *
 * Call `harness.emulator.close()` in afterAll to clean up.
 */
export async function createGmailTestHarness({
  port,
  email,
  messages,
}: {
  port?: number;
  email: string;
  messages: GmailSeedMessage[];
}): Promise<GmailTestHarness> {
  const emulatorPort = port ?? (await getAvailablePort());
  const emulator = await createEmulator({
    service: "google",
    port: emulatorPort,
    seed: {
      google: {
        users: [{ email, name: "Test User" }],
        oauth_clients: [
          {
            client_id: "test-client.apps.googleusercontent.com",
            client_secret: "test-secret",
            redirect_uris: ["http://localhost:3000/callback"],
          },
        ],
        messages,
      },
    },
  });

  const oauth2Client = new auth.OAuth2(
    "test-client.apps.googleusercontent.com",
    "test-secret",
  );
  oauth2Client.setCredentials({ access_token: "emulator-token" });

  const gmailClient = gmail({
    version: "v1",
    auth: oauth2Client,
    rootUrl: emulator.url,
  });

  const logger = createTestLogger();
  const provider = new GmailProvider(gmailClient, logger, "test-account-id");

  // Resolve thread IDs in parallel
  const entries = await Promise.all(
    messages.map(async (seed) => {
      const msg = await gmailClient.users.messages.get({
        userId: "me",
        id: seed.id,
      });
      return [seed.id, msg.data.threadId!] as const;
    }),
  );
  const threadIds = Object.fromEntries(entries);

  return { emulator, gmailClient, provider, threadIds };
}

/**
 * Creates a fully wired Outlook test environment:
 * emulator + Microsoft Graph client + OutlookProvider.
 *
 * Call `harness.emulator.close()` in afterAll to clean up.
 */
export async function createOutlookTestHarness({
  port,
  email,
  messages,
  categories,
  folders,
}: {
  port?: number;
  email: string;
  messages: OutlookSeedMessage[];
  categories?: Array<{ display_name: string; color?: string }>;
  folders?: Array<{
    id: string;
    display_name: string;
    parent_folder_id?: string;
  }>;
}): Promise<OutlookTestHarness> {
  const emulatorPort = port ?? (await getAvailablePort());
  const emulator = await createEmulator({
    service: "microsoft",
    port: emulatorPort,
    seed: {
      microsoft: {
        users: [{ email, name: "Test User" }],
        oauth_clients: [
          {
            client_id: "test-client-id",
            client_secret: "test-secret",
            redirect_uris: ["http://localhost:3000/callback"],
          },
        ],
        categories: categories || [],
        folders: folders || [],
        messages,
      },
    },
  });

  // The Graph client SDK's auth middleware only works with the default
  // graph.microsoft.com baseUrl. We let it build requests normally, then
  // intercept fetch to rewrite the URL to point at the emulator.
  const realFetch = globalThis.fetch;
  const graphBaseUrl = "https://graph.microsoft.com/v1.0";
  const emulatorBaseUrl = `${emulator.url}/v1.0`;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    // Emulator IDs already survive folder moves; its API omits Exchange ID translation.
    if (url === `${graphBaseUrl}/me/translateExchangeIds`) {
      const { inputIds } = (await new Request(input, init).json()) as {
        inputIds: string[];
      };
      return Response.json({
        value: inputIds.map((id) => ({ sourceId: id, targetId: id })),
      });
    }

    if (url.startsWith(graphBaseUrl)) {
      const rewritten = url.replace(graphBaseUrl, emulatorBaseUrl);
      // Preserve Request metadata (method, body, headers) when rewriting
      if (input instanceof Request) {
        return realFetch(new Request(rewritten, input), init);
      }
      return realFetch(rewritten, init);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const restoreFetch = () => {
    globalThis.fetch = realFetch;
  };

  const graphClient = Client.init({
    authProvider: (done) => {
      done(null, "emulator-token");
    },
    fetchOptions: {
      headers: {
        Prefer: 'IdType="ImmutableId"',
      },
    },
  });

  const logger = createTestLogger();
  // OutlookClient wraps a Graph client — we need to replace its internal
  // client with one that points at the emulator instead of graph.microsoft.com
  const outlookClient = new OutlookClient("emulator-token", logger);
  (outlookClient as any).client = graphClient;

  const provider = new OutlookProvider(outlookClient, logger);

  return { emulator, graphClient, provider, restoreFetch };
}

export type NylasSeedMessage = {
  id: string;
  threadId?: string;
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  toEmail?: string;
  /** Multiple recipients, when a fixture carries more than one. */
  toEmails?: string[];
  receivedAt?: Date;
  /** Gmail-shaped label ids for a Google grant. */
  folders?: string[];
  unread?: boolean;
  starred?: boolean;
  body?: string;
  snippet?: string;
  headers?: Array<{ name: string; value: string }>;
};

/** A message as Nylas v3 returns it. */
export type NylasWireMessage = {
  id: string;
  thread_id: string;
  subject: string;
  from: Array<{ name?: string; email: string }>;
  to: Array<{ email: string }>;
  date: number;
  snippet: string;
  body: string;
  folders: string[];
  unread: boolean;
  starred: boolean;
  headers: Array<{ name: string; value: string }>;
};

/** A folder as Nylas v3 returns it. For a Google grant the ids are Gmail's. */
export type NylasWireFolder = {
  id: string;
  name: string;
  attributes: string[];
  system_folder: boolean;
};

export type NylasSeedContact = {
  id: string;
  givenName?: string;
  surname?: string;
  displayName?: string;
  companyName?: string;
  emails: string[];
  pictureUrl?: string;
};

/** A contact as Nylas v3 returns it. */
export type NylasWireContact = {
  id: string;
  given_name: string | null;
  surname: string | null;
  display_name: string | null;
  company_name: string | null;
  emails: Array<{ type: string | null; email: string }>;
  picture_url: string | null;
};

export type NylasSeedCalendar = {
  id: string;
  name?: string;
  description?: string;
  timezone?: string;
  isPrimary?: boolean;
};

/** A calendar as Nylas v3 returns it. Note `name` and `is_primary`. */
export type NylasWireCalendar = {
  id: string;
  name: string | null;
  description: string | null;
  timezone: string | null;
  is_primary: boolean;
};

export type NylasSeedEvent = {
  id: string;
  /** Defaults to the account's own calendar, which is the address on Google. */
  calendarId?: string;
  title?: string;
  description?: string;
  /** Nylas' plain-text rendering of an HTML `description`. */
  textDescription?: string;
  location?: string;
  startTime: Date;
  endTime: Date;
  timezone?: string;
  organizerEmail?: string;
  organizerName?: string;
  participants?: Array<{
    email: string;
    name?: string;
    status?: "yes" | "no" | "maybe" | "noreply";
  }>;
  conferencingUrl?: string;
  icalUid?: string;
  status?: "confirmed" | "cancelled";
  busy?: boolean;
  masterEventId?: string;
};

/** An event as Nylas v3 returns it. */
export type NylasWireEvent = {
  id: string;
  calendar_id: string;
  title: string | null;
  description: string | null;
  text_description?: string | null;
  location: string | null;
  when: NylasWireEventWhen;
  organizer: { email: string; name: string | null };
  participants: Array<{
    email: string;
    name: string | null;
    status: string;
  }>;
  conferencing: { provider: string; details: { url: string } } | null;
  html_link: string;
  ical_uid: string | null;
  status: string;
  busy: boolean;
  master_event_id: string | null;
};

export type NylasWireEventWhen = {
  object: string;
  start_time?: number;
  end_time?: number;
  start_timezone?: string | null;
  end_timezone?: string | null;
  start_date?: string;
  end_date?: string;
  date?: string;
};

export type NylasRecordedRequest = {
  method: string;
  url: URL;
  authorization: string | null;
  body: unknown;
};

export type NylasTestHarness = {
  provider: NylasMailProvider;
  /** The fake's mailbox: assert provider-side effects here. */
  mailbox: NylasWireMessage[];
  /** The fake's folders, seeded with the Gmail system labels. */
  labels: NylasWireFolder[];
  /** The fake's address book. */
  contacts: NylasWireContact[];
  /** The fake's calendars. */
  calendars: NylasWireCalendar[];
  /** The fake's agenda: assert calendar writes here. */
  events: NylasWireEvent[];
  /** The connected account's address, which is also its calendar's id. */
  email: string;
  grantId: string;
  /** Every request the provider made, in order. */
  requests: NylasRecordedRequest[];
  /** Call in afterAll to put globalThis.fetch back. */
  restoreFetch: () => void;
};

/**
 * Creates a Nylas test environment: a fake v3 API at the `fetch` boundary plus
 * a provider wired to it, which is the same seam `createOutlookTestHarness`
 * rewrites. `@inboxzero/emulate` has no Nylas service, so this stands in for it.
 *
 * `NYLAS_API_KEY` and `NYLAS_API_URI` must already be set, because `@/env`
 * validates on first evaluation — and importing this file already evaluates it.
 * Stub them in a `vi.hoisted` block at the top of the test file, guarded by
 * `RUN_INTEGRATION_TESTS` so a skipped run never mutates the environment.
 */
export async function createNylasTestHarness({
  messages,
  contacts = [],
  calendars,
  events = [],
  email = "owner@example.com",
  grantId = "grant-abc",
}: {
  messages: NylasSeedMessage[];
  contacts?: NylasSeedContact[];
  calendars?: NylasSeedCalendar[];
  events?: NylasSeedEvent[];
  email?: string;
  grantId?: string;
}): Promise<NylasTestHarness> {
  const origin = process.env.NYLAS_API_URI;
  if (!process.env.NYLAS_API_KEY || !origin) {
    throw new Error(
      "createNylasTestHarness needs NYLAS_API_KEY and NYLAS_API_URI set before `@/env` is evaluated",
    );
  }

  const mailbox = messages.map(toNylasWireMessage);
  const labels = seedNylasLabels();
  const addressBook = contacts.map(toNylasWireContact);
  const calendarBook = (
    calendars ?? [{ id: email, name: "Owner", isPrimary: true }]
  ).map(toNylasWireCalendar);
  const agenda = events.map((event) => toNylasWireEvent(event, email));
  const requests: NylasRecordedRequest[] = [];

  const realFetch = globalThis.fetch;
  globalThis.fetch = createNylasFetch({
    requests,
    mailbox,
    labels,
    addressBook,
    calendarBook,
    agenda,
    email,
    origin,
    grantId,
    realFetch,
  });
  const restoreFetch = () => {
    globalThis.fetch = realFetch;
  };

  const provider = new NylasMailProvider({
    grantId,
    emailAccountId: "email-account-1",
    logger: createTestLogger(),
  });

  return {
    provider,
    mailbox,
    labels,
    contacts: addressBook,
    calendars: calendarBook,
    events: agenda,
    email,
    grantId,
    requests,
    restoreFetch,
  };
}

/** The system labels every Gmail grant carries, with RFC 9051 attributes. */
function seedNylasLabels(): NylasWireFolder[] {
  return [
    {
      id: "INBOX",
      name: "Inbox",
      attributes: ["\\Inbox"],
      system_folder: true,
    },
    { id: "SENT", name: "Sent", attributes: ["\\Sent"], system_folder: true },
    {
      id: "DRAFT",
      name: "Drafts",
      attributes: ["\\Drafts"],
      system_folder: true,
    },
    {
      id: "TRASH",
      name: "Trash",
      attributes: ["\\Trash"],
      system_folder: true,
    },
    { id: "SPAM", name: "Spam", attributes: ["\\Junk"], system_folder: true },
  ];
}

function toNylasWireMessage(seed: NylasSeedMessage): NylasWireMessage {
  const receivedAt = seed.receivedAt ?? new Date();

  return {
    id: seed.id,
    thread_id: seed.threadId ?? seed.id,
    subject: seed.subject ?? "",
    from: [
      {
        name: seed.fromName ?? "Ada Lovelace",
        email: seed.fromEmail ?? "ada@example.com",
      },
    ],
    to: (seed.toEmails ?? [seed.toEmail ?? "owner@example.com"]).map(
      (email) => ({ email }),
    ),
    // Nylas dates are Unix seconds.
    date: Math.floor(receivedAt.getTime() / 1000),
    snippet: seed.snippet ?? seed.subject ?? "",
    body: seed.body ?? "",
    folders: seed.folders ?? ["INBOX"],
    unread: seed.unread ?? false,
    starred: seed.starred ?? false,
    headers: seed.headers ?? [
      { name: "Message-Id", value: `<${seed.id}@example.com>` },
    ],
  };
}

function toNylasWireContact(seed: NylasSeedContact): NylasWireContact {
  return {
    id: seed.id,
    given_name: seed.givenName ?? null,
    surname: seed.surname ?? null,
    display_name: seed.displayName ?? null,
    company_name: seed.companyName ?? null,
    emails: seed.emails.map((email) => ({ type: "work", email })),
    picture_url: seed.pictureUrl ?? null,
  };
}

function toNylasWireCalendar(seed: NylasSeedCalendar): NylasWireCalendar {
  return {
    id: seed.id,
    name: seed.name ?? null,
    description: seed.description ?? null,
    timezone: seed.timezone ?? null,
    is_primary: seed.isPrimary ?? false,
  };
}

/**
 * For a Google grant the primary calendar's id *is* the account's address, which
 * is also what Nylas free/busy is keyed by — so a seeded event defaults to that
 * id and the two endpoints agree about which calendar is the account's own.
 */
function toNylasWireEvent(
  seed: NylasSeedEvent,
  ownerEmail: string,
): NylasWireEvent {
  return {
    id: seed.id,
    calendar_id: seed.calendarId ?? ownerEmail,
    title: seed.title ?? null,
    description: seed.description ?? null,
    text_description: seed.textDescription ?? null,
    location: seed.location ?? null,
    when: {
      object: "timespan",
      start_time: toUnixSeconds(seed.startTime),
      end_time: toUnixSeconds(seed.endTime),
      start_timezone: seed.timezone ?? null,
      end_timezone: seed.timezone ?? null,
    },
    organizer: {
      email: seed.organizerEmail ?? ownerEmail,
      name: seed.organizerName ?? null,
    },
    participants: (seed.participants ?? []).map((participant) => ({
      email: participant.email,
      name: participant.name ?? null,
      status: participant.status ?? "noreply",
    })),
    conferencing: seed.conferencingUrl
      ? { provider: "Google Meet", details: { url: seed.conferencingUrl } }
      : null,
    html_link: `https://calendar.google.com/event?eid=${seed.id}`,
    ical_uid: seed.icalUid ?? null,
    status: seed.status ?? "confirmed",
    busy: seed.busy ?? true,
    master_event_id: seed.masterEventId ?? null,
  };
}

function toUnixSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Enough of the Nylas v3 messages surface to drive a sync and a mutation, plus
 * a record of what was asked for. Anything else 404s, so a retargeted test
 * fails loudly rather than silently reading nothing.
 */
function createNylasFetch({
  requests,
  mailbox,
  labels,
  addressBook,
  calendarBook,
  agenda,
  email,
  origin,
  grantId,
  realFetch,
}: {
  requests: NylasRecordedRequest[];
  mailbox: NylasWireMessage[];
  labels: NylasWireFolder[];
  addressBook: NylasWireContact[];
  calendarBook: NylasWireCalendar[];
  agenda: NylasWireEvent[];
  email: string;
  origin: string;
  grantId: string;
  realFetch: typeof fetch;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw);

    // Another emulator (Slack, an MCP server, …) owns this origin; the only
    // requirement on the fake is that it does not intercept it.
    if (url.origin !== origin) return realFetch(input, init);

    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    const rawBody = init?.body === undefined ? undefined : String(init.body);

    requests.push({
      method,
      url,
      authorization: headers.get("authorization"),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
    });

    const contactsPath = `/v3/grants/${grantId}/contacts`;
    if (method === "GET" && url.pathname === contactsPath) {
      return Response.json(nylasContactPage(url, addressBook));
    }

    const calendarsPath = `/v3/grants/${grantId}/calendars`;
    if (method === "GET" && url.pathname === calendarsPath) {
      return Response.json({ data: calendarBook, next_cursor: null });
    }

    if (method === "POST" && url.pathname === `${calendarsPath}/free-busy`) {
      return Response.json({
        data: nylasFreeBusy(url, rawBody, agenda, email),
      });
    }

    const eventsPath = `/v3/grants/${grantId}/events`;
    if (url.pathname === eventsPath) {
      if (method === "GET") {
        return Response.json(nylasEventPage(url, agenda, email));
      }
      if (method === "POST") {
        const event = createNylasEvent({
          agenda,
          body: JSON.parse(rawBody ?? "{}") as NylasEventWriteBody,
          calendarId: resolveCalendarId(url, email),
          ownerEmail: email,
        });
        return Response.json({ data: event });
      }
    }

    // Checked before the plain event id, which would otherwise swallow the
    // action segment as part of the id.
    if (url.pathname.startsWith(`${eventsPath}/`)) {
      const [rawId, action] = url.pathname
        .slice(eventsPath.length + 1)
        .split("/");
      const eventId = decodeURIComponent(rawId ?? "");
      const event = agenda.find((candidate) => candidate.id === eventId);

      if (action === "send-rsvp" && method === "POST") {
        if (!event) return nylasNotFound(url.pathname);
        const status = (JSON.parse(rawBody ?? "{}") as { status?: string })
          .status;
        const participant = event.participants.find(
          (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
        );
        if (participant && status) participant.status = status;
        return Response.json({ request_id: "1" });
      }

      if (!action) {
        if (!event) return nylasNotFound(url.pathname);
        if (method === "GET") return Response.json({ data: event });
        if (method === "PUT") {
          applyNylasEventUpdate(
            event,
            JSON.parse(rawBody ?? "{}") as NylasEventWriteBody,
          );
          return Response.json({ data: event });
        }
        if (method === "DELETE") {
          agenda.splice(agenda.indexOf(event), 1);
          return Response.json({ request_id: "1" });
        }
      }
    }

    const foldersPath = `/v3/grants/${grantId}/folders`;
    if (url.pathname === foldersPath) {
      if (method === "GET") {
        return Response.json({ data: labels, next_cursor: null });
      }
      if (method === "POST") {
        const name = (JSON.parse(rawBody ?? "{}") as { name?: string }).name;
        if (!name) return nylasNotFound(url.pathname);
        return Response.json({ data: createNylasLabel(labels, name) });
      }
    }

    const folderId = nylasFolderIdFromPath(url.pathname, foldersPath);
    if (folderId && method === "DELETE") {
      const index = labels.findIndex((label) => label.id === folderId);
      if (index === -1) return nylasNotFound(url.pathname);
      labels.splice(index, 1);
      // Nylas answers a successful delete with no body.
      return new Response(null, { status: 204 });
    }

    const draftsPath = `/v3/grants/${grantId}/drafts`;
    if (url.pathname === draftsPath && method === "POST") {
      const body = JSON.parse(rawBody ?? "{}") as {
        subject?: string;
        body?: string;
        to?: NylasWireMessage["to"];
        from?: NylasWireMessage["from"];
        reply_to_message_id?: string;
      };
      const created = createNylasDraft(mailbox, body);
      return Response.json({ data: { id: created.id } });
    }

    const draftId = nylasDraftIdFromPath(url.pathname, draftsPath);
    if (draftId) {
      const draft = mailbox.find((message) => message.id === draftId);
      if (!draft) return nylasNotFound(url.pathname);

      if (method === "POST") {
        // Sending is what leaves the drafts folder: Nylas answers with the
        // message it delivered, on the thread the draft belonged to.
        draft.folders = ["SENT"];
        return Response.json({
          data: { id: draft.id, thread_id: draft.thread_id },
        });
      }

      if (method === "PUT") {
        applyNylasDraftUpdate(
          draft,
          JSON.parse(rawBody ?? "{}") as NylasDraftUpdate,
        );
        return Response.json({ data: draft });
      }

      if (method === "DELETE") {
        mailbox.splice(mailbox.indexOf(draft), 1);
        return new Response(null, { status: 204 });
      }
    }

    const messagesPath = `/v3/grants/${grantId}/messages`;
    if (method === "GET" && url.pathname === messagesPath) {
      return Response.json(nylasMessagePage(url, mailbox));
    }

    const messageId = nylasMessageIdFromPath(url.pathname, messagesPath);
    if (messageId) {
      const message = mailbox.find((candidate) => candidate.id === messageId);
      if (!message) return nylasNotFound(url.pathname);

      if (method === "GET") return Response.json({ data: message });
      if (method === "PUT") {
        applyNylasUpdate(message, JSON.parse(rawBody ?? "{}"));
        return Response.json({ data: message });
      }
    }

    return nylasNotFound(url.pathname);
  }) as typeof fetch;
}

/**
 * Gmail label ids are opaque; the fake names them after the label so a failure
 * message says which one was involved. Creating the same name twice returns the
 * existing label, as Nylas does for a duplicate.
 */
function createNylasLabel(labels: NylasWireFolder[], name: string) {
  const existing = labels.find((label) => label.name === name);
  if (existing) return existing;

  const created: NylasWireFolder = {
    id: `Label_${name}`,
    name,
    attributes: [],
    system_folder: false,
  };
  labels.push(created);
  return created;
}

/**
 * A draft is a message in the drafts folder, which is why `getDraft` reads it
 * through the message endpoint and `getDrafts` lists the folder. A reply draft
 * inherits the thread of the message it answers.
 */
function createNylasDraft(
  mailbox: NylasWireMessage[],
  body: {
    subject?: string;
    body?: string;
    to?: NylasWireMessage["to"];
    from?: NylasWireMessage["from"];
    reply_to_message_id?: string;
  },
) {
  const id = `draft-${mailbox.length + 1}`;
  const parent = body.reply_to_message_id
    ? mailbox.find((message) => message.id === body.reply_to_message_id)
    : undefined;

  const draft: NylasWireMessage = {
    id,
    thread_id: parent?.thread_id ?? `thread-${id}`,
    subject: body.subject ?? "",
    from: body.from ?? [{ email: "owner@example.com" }],
    to: body.to ?? [],
    date: Math.floor(Date.now() / 1000),
    snippet: "",
    body: body.body ?? "",
    folders: ["DRAFT"],
    unread: false,
    starred: false,
    headers: [{ name: "Message-Id", value: `<${id}@example.com>` }],
  };
  mailbox.push(draft);
  return draft;
}

function nylasDraftIdFromPath(pathname: string, draftsPath: string) {
  if (!pathname.startsWith(`${draftsPath}/`)) return null;
  return decodeURIComponent(pathname.slice(draftsPath.length + 1));
}

type NylasDraftUpdate = {
  body?: string;
  subject?: string;
  to?: NylasWireMessage["to"];
  from?: NylasWireMessage["from"];
};

/** Draft edits replace the fields they carry, the same way sending does. */
function applyNylasDraftUpdate(
  draft: NylasWireMessage,
  update: NylasDraftUpdate,
) {
  if (update.body !== undefined) draft.body = update.body;
  if (update.subject !== undefined) draft.subject = update.subject;
  if (update.to) draft.to = update.to;
  if (update.from) draft.from = update.from;
}

function nylasMessagePage(url: URL, mailbox: NylasWireMessage[]) {
  const limit = Number(url.searchParams.get("limit") ?? mailbox.length);
  const offset = Number(url.searchParams.get("page_token") ?? 0);
  const receivedAfter = Number(url.searchParams.get("received_after") ?? 0);
  const searchQuery = url.searchParams.get("search_query_native");
  const threadId = url.searchParams.get("thread_id");
  const folderId = url.searchParams.get("in");

  const visible = mailbox
    .filter((message) => message.date >= receivedAfter)
    .filter((message) => (threadId ? message.thread_id === threadId : true))
    .filter((message) => (folderId ? message.folders.includes(folderId) : true))
    .filter((message) => nylasMatchesSearch(message, searchQuery))
    .sort((a, b) => b.date - a.date);
  const page = visible.slice(offset, offset + limit);

  return {
    // Nylas includes the body in a list response; the reduced `fields` value
    // only trims the header set, which is why a reader can render without a
    // second call and why hydration is about full headers, not the body.
    data: page,
    next_cursor:
      offset + page.length < visible.length
        ? String(offset + page.length)
        : null,
  };
}

/**
 * A plain term, matched against subject and body. The fake has no Gmail
 * operator parser — a test that searches passes a token, not a query language —
 * but it must still narrow, or a search assertion would pass on any mailbox.
 */
function nylasMatchesSearch(
  message: NylasWireMessage,
  searchQuery: string | null,
) {
  const term = searchQuery?.trim().toLowerCase();
  if (!term) return true;

  return `${message.subject}\n${message.body}`.toLowerCase().includes(term);
}

function applyNylasUpdate(
  message: NylasWireMessage,
  update: { folders?: string[]; unread?: boolean; starred?: boolean },
) {
  if (update.folders) message.folders = update.folders;
  if (update.unread !== undefined) message.unread = update.unread;
  if (update.starred !== undefined) message.starred = update.starred;
}

function nylasMessageIdFromPath(pathname: string, messagesPath: string) {
  if (!pathname.startsWith(`${messagesPath}/`)) return null;
  return decodeURIComponent(pathname.slice(messagesPath.length + 1));
}

/**
 * The contacts list. `search_query_native` is provider syntax in production; the
 * fake narrows on a plain term so a search assertion cannot pass on a full
 * address book.
 */
function nylasContactPage(url: URL, contacts: NylasWireContact[]) {
  const limit = Number(url.searchParams.get("limit") ?? contacts.length);
  const offset = Number(url.searchParams.get("page_token") ?? 0);
  const term = url.searchParams
    .get("search_query_native")
    ?.trim()
    .toLowerCase();

  const visible = contacts.filter((contact) =>
    nylasContactMatches(contact, term),
  );
  const page = visible.slice(offset, offset + limit);

  return {
    data: page,
    next_cursor:
      offset + page.length < visible.length
        ? String(offset + page.length)
        : null,
  };
}

function nylasContactMatches(contact: NylasWireContact, term?: string) {
  if (!term) return true;

  const haystack = [
    contact.given_name,
    contact.surname,
    contact.display_name,
    contact.company_name,
    ...contact.emails.map((email) => email.email),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(term);
}

function nylasFolderIdFromPath(pathname: string, foldersPath: string) {
  if (!pathname.startsWith(`${foldersPath}/`)) return null;
  return decodeURIComponent(pathname.slice(foldersPath.length + 1));
}

/**
 * Nylas documents `calendar_id=primary` as an alias that is answered with the
 * real calendar id, which for a Google grant is the account's own address.
 */
function resolveCalendarId(url: URL, ownerEmail: string) {
  const requested = url.searchParams.get("calendar_id");
  return !requested || requested === "primary" ? ownerEmail : requested;
}

/**
 * Events in the window, with the overlap semantics Nylas documents: an event is
 * returned when it overlaps the window rather than only when it sits inside it.
 */
function nylasEventPage(
  url: URL,
  agenda: NylasWireEvent[],
  ownerEmail: string,
) {
  const icalUid = url.searchParams.get("ical_uid");
  const calendarId = resolveCalendarId(url, ownerEmail);
  const start = numberOrNull(url.searchParams.get("start"));
  const end = numberOrNull(url.searchParams.get("end"));
  const attendees = (url.searchParams.get("attendees") ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  const showCancelled = url.searchParams.get("show_cancelled") === "true";
  const limit = numberOrNull(url.searchParams.get("limit")) ?? 50;
  const offset = numberOrNull(url.searchParams.get("page_token")) ?? 0;

  const visible = agenda.filter((event) => {
    // The UID filter is exclusive of every other one, as Nylas documents.
    if (icalUid) return event.ical_uid === icalUid;

    if (!showCancelled && event.status === "cancelled") return false;
    if (event.calendar_id !== calendarId) return false;

    if (attendees.length > 0) {
      const onEvent = new Set(
        event.participants.map((participant) =>
          participant.email?.toLowerCase(),
        ),
      );
      if (!attendees.some((address) => onEvent.has(address))) return false;
    }

    const window = eventWindowSeconds(event);
    if (start !== null && window.end <= start) return false;
    if (end !== null && window.start >= end) return false;

    return true;
  });

  const page = visible.slice(offset, offset + limit);

  return {
    data: page,
    next_cursor:
      offset + page.length < visible.length
        ? String(offset + page.length)
        : null,
  };
}

function eventWindowSeconds(event: NylasWireEvent) {
  return {
    start: event.when.start_time ?? 0,
    end: event.when.end_time ?? event.when.start_time ?? 0,
  };
}

function createNylasEvent({
  agenda,
  body,
  calendarId,
  ownerEmail,
}: {
  agenda: NylasWireEvent[];
  body: NylasEventWriteBody;
  calendarId: string;
  ownerEmail: string;
}) {
  const id = `event-${agenda.length + 1}`;
  const when = body.when ?? { object: "timespan" };

  const event: NylasWireEvent = {
    id,
    calendar_id: calendarId,
    title: body.title ?? null,
    description: body.description ?? null,
    text_description: body.description ?? null,
    location: body.location ?? null,
    when,
    organizer: { email: ownerEmail, name: null },
    participants: (body.participants ?? []).map((participant) => ({
      email: participant.email,
      name: participant.name ?? null,
      status: "noreply",
    })),
    // Only autocreate produces a link; a conference that was merely passed in by
    // hand is not something Nylas would invent an URL for.
    conferencing: body.conferencing?.autocreate
      ? {
          provider: body.conferencing.provider,
          details: { url: `https://meet.google.com/${id}` },
        }
      : null,
    html_link: `https://calendar.google.com/event?eid=${id}`,
    ical_uid: `${id}@google.com`,
    status: "confirmed",
    busy: body.busy ?? true,
    master_event_id: null,
  };

  agenda.push(event);
  return event;
}

/** PUT replaces the nested objects it carries, as Nylas documents. */
function applyNylasEventUpdate(
  event: NylasWireEvent,
  body: NylasEventWriteBody,
) {
  if (body.title !== undefined) event.title = body.title;
  if (body.description !== undefined) {
    event.description = body.description;
    event.text_description = body.description ?? null;
  }
  if (body.location !== undefined) event.location = body.location ?? null;
  if (body.when) event.when = body.when;
  if (body.participants) {
    event.participants = body.participants.map((participant) => ({
      email: participant.email,
      name: participant.name ?? null,
      status: "noreply",
    }));
  }
  if (body.conferencing?.autocreate) {
    event.conferencing = {
      provider: body.conferencing.provider,
      details: { url: `https://meet.google.com/${event.id}` },
    };
  }
  if (body.busy !== undefined) event.busy = body.busy;
}

/**
 * Busy blocks per address, derived from the agenda.
 *
 * Free/busy reports the blocks on an address's *primary* calendar, and for a
 * Google grant that calendar's id is the address itself — which is why this
 * matches on the calendar id rather than looking at participants.
 */
function nylasFreeBusy(
  url: URL,
  rawBody: string | undefined,
  agenda: NylasWireEvent[],
  ownerEmail: string,
) {
  const body = JSON.parse(rawBody ?? "{}") as {
    start_time?: number;
    end_time?: number;
    emails?: string[];
  };
  const start = body.start_time ?? 0;
  const end = body.end_time ?? 0;

  return (body.emails ?? []).map((address) => {
    const forCalendar = resolveCalendarId(url, ownerEmail);
    const calendarId = address;

    // Nylas reports the blocks of the calendar being asked about, so only the
    // requested address's own calendar contributes.
    const timeSlots = agenda
      .filter(
        (event) =>
          event.status !== "cancelled" &&
          event.busy &&
          (event.calendar_id === calendarId ||
            (calendarId === forCalendar && event.calendar_id === ownerEmail)),
      )
      .map((event) => eventWindowSeconds(event))
      .filter((window) => window.end > start && window.start < end)
      .map((window) => ({
        start_time: Math.max(window.start, start),
        end_time: Math.min(window.end, end),
        status: "busy",
        object: "time_slot",
      }));

    return { email: address, time_slots: timeSlots, object: "free_busy" };
  });
}

function numberOrNull(value: string | null) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type NylasEventWriteBody = {
  title?: string;
  description?: string;
  location?: string;
  when?: NylasWireEventWhen;
  participants?: Array<{ email: string; name?: string }>;
  conferencing?: {
    provider: string;
    autocreate?: { conf_grant_id?: string };
  };
  busy?: boolean;
};

function nylasNotFound(pathname: string) {
  return Response.json(
    { error: { message: `no route for ${pathname}`, type: "not_found" } },
    { status: 404 },
  );
}

export async function createSlackTestHarness({
  port,
  team,
  users = [],
  channels = [],
  token = "emulator-token",
}: {
  port?: number;
  team: { name: string; domain: string };
  users?: SlackSeedUser[];
  channels?: SlackSeedChannel[];
  token?: string;
}): Promise<SlackTestHarness> {
  const emulatorPort = port ?? (await getAvailablePort());
  const emulator = await createEmulator({
    service: "slack",
    port: emulatorPort,
    seed: {
      slack: {
        team,
        users,
        channels,
      },
    },
  });

  const client = new WebClient(token, {
    slackApiUrl: `${emulator.url}/api/`,
  });

  const auth = await client.auth.test();
  const listedChannels = await client.conversations.list({
    types: "public_channel,private_channel",
  });
  const listedUsers = await client.users.list();

  return {
    emulator,
    client,
    teamId: auth.team_id!,
    channelsByName: Object.fromEntries(
      (listedChannels.channels ?? [])
        .filter((channel) => channel.name && channel.id)
        .map((channel) => [channel.name!, channel.id!]),
    ),
    usersByName: Object.fromEntries(
      (listedUsers.members ?? [])
        .filter((user) => user.name && user.id)
        .map((user) => [user.name!, user.id!]),
    ),
  };
}

export function createSignedSlackRequest({
  body,
  signingSecret = "test-signing-secret",
  timestamp = `${Math.floor(Date.now() / 1000)}`,
  url = "https://example.com/api/slack/events",
}: {
  body: string | Record<string, unknown>;
  signingSecret?: string;
  timestamp?: string;
  url?: string;
}) {
  const requestBody = typeof body === "string" ? body : JSON.stringify(body);
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${requestBody}`)
    .digest("hex")}`;

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: requestBody,
  });
}

export async function getAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (typeof address === "object" && address?.port) {
          resolve(address.port);
          return;
        }

        reject(new Error("Failed to allocate an emulator port"));
      });
    });
  });
}
