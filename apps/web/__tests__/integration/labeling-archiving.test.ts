/**
 * Integration test: labeling & archiving round-trips
 *
 * Covers the provider-level read/label/archive operations in both directions.
 * The old file drove `utils/gmail/label.ts` and `utils/gmail/thread.ts` directly;
 * those client-level wrappers have no Nylas equivalent and go with the direct
 * Gmail transport, so the coverage now sits on the provider interface — and
 * where the wrappers only ever tested one direction (mark read, add label,
 * archive), this covers the round trip (unread again, label removed, unarchived).
 *
 * Usage:
 *   pnpm test-integration labeling-archiving
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createNylasTestHarness,
  type NylasSeedMessage,
  type NylasTestHarness,
} from "./helpers";

vi.mock("server-only", () => ({}));

// `@/env` validates on first evaluation and the Nylas transport reads its URI
// and key from it, so they have to be in place before the imports above resolve.
// Guarded so a run that skips these tests never touches the environment.
vi.hoisted(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    process.env.NYLAS_API_KEY = "test-nylas-api-key";
    process.env.NYLAS_API_URI = "https://nylas.test";
  }
});

afterAll(() => {
  if (process.env.RUN_INTEGRATION_TESTS) {
    delete process.env.NYLAS_API_KEY;
    delete process.env.NYLAS_API_URI;
  }
});

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS;
const BASE_MS = Date.UTC(2024, 3, 1, 12, 0, 0);

/**
 * `thread_pair` holds two messages on purpose: every thread-level operation has
 * to reach both, which a one-message-per-thread seed can never prove.
 */
function seedMessages(): NylasSeedMessage[] {
  return [
    {
      id: "msg_pair_a",
      threadId: "thread_pair",
      subject: "Pair A",
      body: "First of two",
      folders: ["INBOX"],
      unread: true,
      receivedAt: new Date(BASE_MS),
    },
    {
      id: "msg_pair_b",
      threadId: "thread_pair",
      subject: "Re: Pair A",
      body: "Second of two",
      folders: ["INBOX"],
      unread: true,
      receivedAt: new Date(BASE_MS + 60_000),
    },
    {
      id: "msg_single",
      threadId: "thread_single",
      subject: "Single",
      body: "On its own",
      folders: ["INBOX", "STARRED"],
      starred: true,
      receivedAt: new Date(BASE_MS + 120_000),
    },
  ];
}

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Labeling & archiving operations — Nylas",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    beforeAll(async () => {
      harness = await createNylasTestHarness({ messages: seedMessages() });
    });

    afterAll(() => {
      harness?.restoreFetch();
    });

    async function labelIdsOf(messageId: string) {
      const message = await harness.provider.getMessage(messageId);
      return message.labelIds ?? [];
    }

    test("markReadThread sets and clears read state on every message in the thread", async () => {
      await harness.provider.markReadThread("thread_pair", true);

      expect(await labelIdsOf("msg_pair_a")).not.toContain("UNREAD");
      expect(await labelIdsOf("msg_pair_b")).not.toContain("UNREAD");

      // Back again: the reverse direction is what the wrapper tests never did.
      await harness.provider.markReadThread("thread_pair", false);

      expect(await labelIdsOf("msg_pair_a")).toContain("UNREAD");
      expect(await labelIdsOf("msg_pair_b")).toContain("UNREAD");
    });

    test("a label added to a message can be removed from the whole thread", async () => {
      const label = await harness.provider.createLabel("RoundTrip");

      await harness.provider.labelMessage({
        messageId: "msg_pair_a",
        labelId: label.id,
        labelName: "RoundTrip",
      });
      expect(await labelIdsOf("msg_pair_a")).toContain(label.id);

      await harness.provider.removeThreadLabel("thread_pair", label.id);

      // Nylas replaces the folder set, so removal must leave the rest intact.
      expect(await labelIdsOf("msg_pair_a")).not.toContain(label.id);
      expect(await labelIdsOf("msg_pair_a")).toContain("INBOX");
      expect(await labelIdsOf("msg_pair_b")).not.toContain(label.id);
    });

    test("archiveThread and unarchiveThread round-trip INBOX", async () => {
      await harness.provider.archiveThread(
        "thread_single",
        "owner@example.com",
      );
      expect(await labelIdsOf("msg_single")).not.toContain("INBOX");

      await harness.provider.unarchiveThread("thread_single");
      expect(await labelIdsOf("msg_single")).toContain("INBOX");
    });

    test("deleteLabel removes the label from the provider", async () => {
      const label = await harness.provider.createLabel("Disposable");
      const created = await harness.provider.getLabelByName("Disposable");
      expect(created).not.toBeNull();

      await harness.provider.deleteLabel(label.id);

      expect(await harness.provider.getLabelByName("Disposable")).toBeNull();
      const labels = await harness.provider.getLabels();
      expect(labels.some((candidate) => candidate.id === label.id)).toBe(false);
    });

    test("starMessage marks a message as starred", async () => {
      await harness.provider.starMessage("msg_pair_a");

      expect(await labelIdsOf("msg_pair_a")).toContain("STARRED");
    });
  },
);
