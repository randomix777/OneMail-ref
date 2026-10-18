/**
 * Integration test: Nylas contacts
 *
 * The compose picker reads contacts and their photos through the provider, so
 * this drives both over the fake API: one walk for suggestions (narrowed by the
 * query) and one for the avatar map.
 *
 * Usage:
 *   pnpm test-integration nylas-contacts
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createNylasTestHarness, type NylasTestHarness } from "./helpers";

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

describe.skipIf(!RUN_INTEGRATION_TESTS)(
  "Nylas contacts",
  { timeout: 30_000 },
  () => {
    let harness: NylasTestHarness;

    beforeAll(async () => {
      harness = await createNylasTestHarness({
        messages: [],
        contacts: [
          {
            id: "contact-ada",
            givenName: "Ada",
            surname: "Lovelace",
            emails: ["ada@example.com"],
            pictureUrl: "https://example.com/ada.png",
          },
          {
            id: "contact-grace",
            displayName: "Grace Hopper",
            emails: ["grace@example.com", "grace@navy.example.com"],
          },
          {
            id: "contact-engines",
            companyName: "Analytical Engines Ltd",
            emails: ["hello@engines.example.com"],
          },
        ],
      });
    });

    afterAll(() => {
      harness?.restoreFetch();
    });

    test("suggests the contacts that match the query", async () => {
      const contacts = await harness.provider.searchContacts("ada");

      expect(contacts).toEqual([
        {
          emailAddress: "ada@example.com",
          name: "Ada Lovelace",
          profilePictureUrl: "https://example.com/ada.png",
        },
      ]);
    });

    test("expands a contact with several addresses", async () => {
      const contacts = await harness.provider.searchContacts("grace");

      expect(contacts.map((contact) => contact.emailAddress).sort()).toEqual([
        "grace@example.com",
        "grace@navy.example.com",
      ]);
      expect(contacts.every((contact) => contact.name === "Grace Hopper")).toBe(
        true,
      );
    });

    test("falls back to the company name when there is no person name", async () => {
      const contacts = await harness.provider.searchContacts("engines");

      expect(contacts).toEqual([
        {
          emailAddress: "hello@engines.example.com",
          name: "Analytical Engines Ltd",
          profilePictureUrl: undefined,
        },
      ]);
    });

    test("returns no suggestions for an empty query", async () => {
      harness.requests.length = 0;

      await expect(harness.provider.searchContacts("  ")).resolves.toEqual([]);
      // Nothing to search for means no request at all.
      expect(
        harness.requests.filter((request) =>
          request.url.pathname.endsWith("/contacts"),
        ),
      ).toEqual([]);
    });

    test("builds the avatar map keyed by canonical address", async () => {
      const photos = await harness.provider.getContactPhotos();

      expect(photos).toEqual({
        "ada@example.com": "https://example.com/ada.png",
      });
    });
  },
);
