import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { saasFounderMixedInbox } from "@/__tests__/fixtures/inboxes/demo-inboxes";
import { toNylasSeedMessages } from "@/__tests__/fixtures/inboxes/adapters";
import {
  createNylasTestHarness,
  type NylasTestHarness,
} from "@/__tests__/integration/helpers";

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

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "demo inbox fixture Nylas adapter",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    beforeAll(async () => {
      harness = await createNylasTestHarness({
        messages: toNylasSeedMessages(saasFounderMixedInbox),
      });
    });

    afterAll(() => {
      harness?.restoreFetch();
      if (process.env.RUN_INTEGRATION_TESTS) {
        delete process.env.NYLAS_API_KEY;
        delete process.env.NYLAS_API_URI;
      }
    });

    test("forwards a Gmail-style query untouched instead of rewriting it", async () => {
      // Nylas hands `search_query_native` to the provider, which is what keeps
      // Gmail operators working through the transport. Translating the query
      // here would silently change what users' rules match.
      harness.requests.length = 0;

      await harness.provider.searchMessages({
        query: "from:no-reply-aws@amazon.com",
        maxResults: 5,
      });

      const listCall = harness.requests.find((request) =>
        request.url.pathname.endsWith("/messages"),
      );
      expect(listCall?.url.searchParams.get("search_query_native")).toBe(
        "from:no-reply-aws@amazon.com",
      );
    });

    test("searches and reads a message from the shared fixture", async () => {
      const result = await harness.provider.searchMessages({
        query: "Root MFA disabled",
        maxResults: 5,
      });
      const securityMessage = result.messages.find(
        (message) =>
          message.subject === "Root MFA disabled on production account",
      );

      expect(securityMessage).toBeDefined();
      // The fixture's thread id survives the adapter, so conversation grouping
      // is preserved end to end.
      expect(securityMessage?.threadId).toBeTruthy();

      const fullMessage = await harness.provider.getMessage(
        securityMessage!.id,
      );

      expect(fullMessage.subject).toBe(
        "Root MFA disabled on production account",
      );
      expect(fullMessage.textPlain).toContain(
        "root multi-factor authentication was disabled",
      );
    });
  },
);
