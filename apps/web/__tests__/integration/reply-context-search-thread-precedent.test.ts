import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { searchReplyContextEmails } from "@/utils/ai/reply/reply-context-collector";
import type { EmailProvider } from "@/utils/email/types";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import type { ParsedMessage } from "@/utils/types";
import {
  createNylasTestHarness,
  createOutlookTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
  type OutlookTestHarness,
} from "./helpers";

// `@/env` validates on first evaluation and the Nylas transport reads its URI
// and key from it, so they have to be in place before the imports above resolve.
// Guarded so a run that skips these tests never touches the environment.
vi.hoisted(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    process.env.NYLAS_API_KEY = "test-nylas-api-key";
    process.env.NYLAS_API_URI = "https://nylas.test";
  }
});

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const NYLAS_EMAIL = "account@example.com";
const OUTLOOK_EMAIL = "account@outlook.example.com";
const HISTORICAL_THREAD_ID = "thread-1";
const HISTORICAL_CONVERSATION_ID = "conversation-1";
const CURRENT_THREAD_ID = "thread-2";
const CURRENT_MESSAGE_ID = "message-1";
const SEARCH_QUERY = "WayFair";
const SEARCH_AFTER = new Date("2026-01-01T00:00:00Z");

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "reply-context search thread precedent — Nylas",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    beforeAll(async () => {
      harness = await createNylasTestHarness({
        messages: nylasFurniturePrecedentSeed(NYLAS_EMAIL),
      });
    });

    afterAll(() => {
      harness?.restoreFetch();
      if (process.env.RUN_INTEGRATION_TESTS) {
        delete process.env.NYLAS_API_KEY;
        delete process.env.NYLAS_API_URI;
      }
    });

    providerPrecedentSuite(() => harness.provider, NYLAS_EMAIL);
  },
);

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "reply-context search thread precedent — Outlook",
  { timeout: 30_000 },
  () => {
    let harness: OutlookTestHarness;

    beforeAll(async () => {
      harness = await createOutlookTestHarness({
        email: OUTLOOK_EMAIL,
        messages: outlookFurniturePrecedentSeed(OUTLOOK_EMAIL),
      });
    });

    afterAll(async () => {
      harness?.restoreFetch();
      await harness?.emulator.close();
    });

    providerPrecedentSuite(() => harness.provider, OUTLOOK_EMAIL);
  },
);

function providerPrecedentSuite(
  getProvider: () => EmailProvider,
  accountEmail: string,
) {
  test("message-level historical search misses the prior correction", async () => {
    const messageLevelContext = await collectMessageLevelSearchContext(
      getProvider(),
      SEARCH_QUERY,
    );
    const senders = messageLevelContext.map((email) => email.from);

    expect(messageLevelContext.length).toBeGreaterThan(0);
    expect(senders.some((sender) => sender.includes(accountEmail))).toBe(false);
  });

  test("production historical search expands matching hits and excludes the current thread", async () => {
    const threadLevelContext = await searchReplyContextEmails({
      emailProvider: getProvider(),
      query: SEARCH_QUERY,
      after: SEARCH_AFTER,
      currentThread: getCurrentWayfairThreadContext(accountEmail),
    });
    const senders = threadLevelContext.map((email) => email.from);

    expect(threadLevelContext.length).toBeGreaterThanOrEqual(3);
    expect(senders.some((sender) => sender.includes(accountEmail))).toBe(true);
    expect(
      countEmailSendersContaining(threadLevelContext, "customer@example.com"),
    ).toBe(2);
    expect(
      senders.some((sender) => sender.includes("new-customer@example.com")),
    ).toBe(false);
  });
}

async function collectMessageLevelSearchContext(
  provider: EmailProvider,
  query: string,
) {
  const { messages } = await provider.getMessagesWithPagination({
    query,
    maxResults: 20,
    after: SEARCH_AFTER,
  });

  return messages.map(toCollectorEmail);
}

function getCurrentWayfairThreadContext(accountEmail: string) {
  return [
    {
      id: CURRENT_MESSAGE_ID,
      threadId: CURRENT_THREAD_ID,
      from: "new-customer@example.com",
      to: accountEmail,
      subject: "Light strip colors",
      content:
        "I bought a WayFair desk and need help changing the light strip colors.",
      date: new Date("2026-05-12T12:00:00Z"),
    },
  ];
}

function toCollectorEmail(message: ParsedMessage) {
  return getEmailForLLM(message, {
    maxLength: 2000,
  });
}

function countEmailSendersContaining(
  emails: Array<{ from: string }>,
  senderEmail: string,
) {
  return emails.filter((email) => email.from.includes(senderEmail)).length;
}

function nylasFurniturePrecedentSeed(email: string): NylasSeedMessage[] {
  return [
    {
      id: CURRENT_MESSAGE_ID,
      threadId: CURRENT_THREAD_ID,
      fromEmail: "new-customer@example.com",
      toEmail: email,
      subject: "Light strip colors",
      body: "I bought a WayFair desk and need help changing the light strip colors.",
      folders: ["INBOX"],
      receivedAt: new Date(1_778_600_000_000),
    },
    {
      id: "message-2",
      threadId: HISTORICAL_THREAD_ID,
      fromEmail: "customer@example.com",
      toEmail: email,
      subject: "OneMail Support Request",
      body: `Good evening!

I just bought from WayFair your Farmhouse L Shaped Standing Desk, 55 Inch Height Adjustable Corner Desk With Storage Drawers, Standing Computer Desks With Power Outlets For Home Office.

I've assembled it all and the control panel for the rising desk just reads "RsT". I'm unable to raise or lower the desk.

Could you please advise me on how I can clear the code?`,
      folders: ["INBOX"],
      receivedAt: new Date(1_778_131_920_000),
    },
    {
      id: "message-3",
      threadId: HISTORICAL_THREAD_ID,
      fromEmail: email,
      toEmail: "customer@example.com",
      subject: "Re: OneMail Support Request",
      body: "Hey, we don't sell furniture. This is the wrong email address. We're an email company: https://jyisolutions.com",
      folders: ["SENT"],
      receivedAt: new Date(1_778_156_940_000),
      headers: [
        { name: "Message-Id", value: "<message-3@example.com>" },
        { name: "In-Reply-To", value: "<message-2@example.com>" },
        { name: "References", value: "<message-2@example.com>" },
      ],
    },
    {
      id: "message-4",
      threadId: HISTORICAL_THREAD_ID,
      fromEmail: "customer@example.com",
      toEmail: email,
      subject: "Re: OneMail Support Request",
      body: "Thx for letting me know!",
      folders: ["INBOX"],
      receivedAt: new Date(1_778_188_620_000),
      headers: [
        { name: "Message-Id", value: "<message-4@example.com>" },
        { name: "In-Reply-To", value: "<message-3@example.com>" },
        {
          name: "References",
          value: "<message-2@example.com> <message-3@example.com>",
        },
      ],
    },
    {
      id: "message-5",
      threadId: "thread-3",
      fromEmail: "receipts@example.com",
      toEmail: email,
      subject: "Receipt",
      body: "A generic WayFair receipt with no support precedent.",
      folders: ["INBOX"],
      receivedAt: new Date(1_778_000_000_000),
    },
  ];
}

function outlookFurniturePrecedentSeed(email: string) {
  return [
    {
      microsoft_id: CURRENT_MESSAGE_ID,
      conversation_id: CURRENT_THREAD_ID,
      internet_message_id: "<message-1@example.com>",
      user_email: email,
      from: { address: "new-customer@example.com", name: "New Customer" },
      to_recipients: [{ address: email }],
      subject: "Light strip colors",
      body_content_type: "text" as const,
      body_content:
        "I bought a WayFair desk and need help changing the light strip colors.",
      body_text_content:
        "I bought a WayFair desk and need help changing the light strip colors.",
      parent_folder_id: "inbox",
      is_read: true,
      received_date_time: "2026-05-12T12:00:00Z",
    },
    {
      microsoft_id: "message-2",
      conversation_id: HISTORICAL_CONVERSATION_ID,
      internet_message_id: "<message-2@example.com>",
      user_email: email,
      from: { address: "customer@example.com", name: "Customer" },
      to_recipients: [{ address: email }],
      subject: "OneMail Support Request",
      body_content_type: "text" as const,
      body_content: `Good evening!

I just bought from WayFair your Farmhouse L Shaped Standing Desk, 55 Inch Height Adjustable Corner Desk With Storage Drawers, Standing Computer Desks With Power Outlets For Home Office.

I've assembled it all and the control panel for the rising desk just reads "RsT". I'm unable to raise or lower the desk.

Could you please advise me on how I can clear the code?`,
      body_text_content: `Good evening!

I just bought from WayFair your Farmhouse L Shaped Standing Desk, 55 Inch Height Adjustable Corner Desk With Storage Drawers, Standing Computer Desks With Power Outlets For Home Office.

I've assembled it all and the control panel for the rising desk just reads "RsT". I'm unable to raise or lower the desk.

Could you please advise me on how I can clear the code?`,
      parent_folder_id: "inbox",
      is_read: true,
      received_date_time: "2026-05-07T02:52:00Z",
    },
    {
      microsoft_id: "message-3",
      conversation_id: HISTORICAL_CONVERSATION_ID,
      internet_message_id: "<message-3@example.com>",
      user_email: email,
      from: { address: email, name: "Test User" },
      to_recipients: [{ address: "customer@example.com" }],
      subject: "Re: OneMail Support Request",
      body_content_type: "text" as const,
      body_content:
        "Hey, we don't sell furniture. This is the wrong email address. We're an email company: https://jyisolutions.com",
      body_text_content:
        "Hey, we don't sell furniture. This is the wrong email address. We're an email company: https://jyisolutions.com",
      parent_folder_id: "sentitems",
      is_read: true,
      received_date_time: "2026-05-07T09:29:00Z",
      sent_date_time: "2026-05-07T09:29:00Z",
    },
    {
      microsoft_id: "message-4",
      conversation_id: HISTORICAL_CONVERSATION_ID,
      internet_message_id: "<message-4@example.com>",
      user_email: email,
      from: { address: "customer@example.com", name: "Customer" },
      to_recipients: [{ address: email }],
      subject: "Re: OneMail Support Request",
      body_content_type: "text" as const,
      body_content: "Thx for letting me know!",
      body_text_content: "Thx for letting me know!",
      parent_folder_id: "inbox",
      is_read: true,
      received_date_time: "2026-05-07T17:17:00Z",
    },
    {
      microsoft_id: "message-5",
      conversation_id: "conversation-2",
      internet_message_id: "<message-5@example.com>",
      user_email: email,
      from: { address: "receipts@example.com", name: "Receipts" },
      to_recipients: [{ address: email }],
      subject: "Receipt",
      body_content_type: "text" as const,
      body_content: "A generic WayFair receipt with no support precedent.",
      body_text_content: "A generic WayFair receipt with no support precedent.",
      parent_folder_id: "inbox",
      is_read: true,
      received_date_time: "2026-05-06T12:00:00Z",
    },
  ];
}
