/**
 * Integration test: draft creation & sending
 *
 * Drives the provider's draft surface — `draftEmail` (reply draft creation),
 * `getDrafts`, `getDraft` and `sendDraft` — against the Nylas fake. The old file
 * called `utils/gmail/mail.ts` and `utils/gmail/draft.ts` directly, which have no
 * Nylas equivalent and go with the direct Gmail transport.
 *
 * Usage:
 *   pnpm test-integration draft-creation
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createNylasTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
} from "./helpers";

// draftEmail needs ensureEmailSendingEnabled which checks env vars
vi.mock("@/utils/mail", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/utils/mail")>();
  return {
    ...original,
    ensureEmailSendingEnabled: () => {},
  };
});

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
const TEST_EMAIL = "draft-test@example.com";

const SEED_MESSAGES: NylasSeedMessage[] = [
  {
    id: "msg_original",
    threadId: "thread_project",
    fromName: "Alice",
    fromEmail: "alice@example.com",
    toEmail: TEST_EMAIL,
    subject: "Project update",
    body: "Here is the latest update on the project.",
    folders: ["INBOX"],
    unread: true,
    receivedAt: new Date(1_711_900_000_000),
  },
];

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Draft creation & sending",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    beforeAll(async () => {
      harness = await createNylasTestHarness({ messages: SEED_MESSAGES });
    });

    afterAll(() => {
      harness?.restoreFetch();
      if (process.env.RUN_INTEGRATION_TESTS) {
        delete process.env.NYLAS_API_KEY;
        delete process.env.NYLAS_API_URI;
      }
    });

    async function originalMessage() {
      return harness.provider.getMessage("msg_original");
    }

    test("draftEmail creates a reply draft on the original's thread", async () => {
      const original = await originalMessage();

      const { draftId } = await harness.provider.draftEmail(
        original,
        { content: "Thanks for the update! I'll review this today." },
        TEST_EMAIL,
      );

      expect(draftId).toBeDefined();

      // The draft appears in the drafts folder…
      const drafts = await harness.provider.getDrafts();
      expect(drafts.some((draft) => draft.id === draftId)).toBe(true);

      // …and belongs to the conversation it answers, which is what makes the
      // reply land in the right thread when it is sent.
      const draft = await harness.provider.getDraft(draftId);
      expect(draft?.threadId).toBe(original.threadId);
    });

    test("sendDraft sends the draft and takes it out of the drafts folder", async () => {
      const original = await originalMessage();
      const { draftId } = await harness.provider.draftEmail(
        original,
        { content: "Draft that will be sent." },
        TEST_EMAIL,
      );

      const sent = await harness.provider.sendDraft(draftId);

      expect(sent.messageId).toBe(draftId);
      expect(sent.threadId).toBe(original.threadId);

      const drafts = await harness.provider.getDrafts();
      expect(drafts.some((draft) => draft.id === draftId)).toBe(false);
    });

    test("draftEmail with an explicit subject overrides the reply subject", async () => {
      const original = await originalMessage();

      const { draftId } = await harness.provider.draftEmail(
        original,
        {
          content: "Changed subject reply.",
          subject: "Custom Subject Override",
        },
        TEST_EMAIL,
      );

      const draft = await harness.provider.getDraft(draftId);
      expect(draft?.subject).toBe("Custom Subject Override");
    });
  },
);
