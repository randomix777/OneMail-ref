import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { NylasApiError } from "@/utils/nylas/client";
import {
  listNylasContactPhotos,
  listNylasContacts,
  searchNylasContacts,
} from "@/utils/nylas/contacts";

const nylasFetch = vi.hoisted(() => vi.fn());

vi.mock("@/utils/nylas/client", async (importOriginal) => {
  // `isNylasErrorWithStatus` is what decides whether a 403 is a missing feature,
  // so it stays real while only the network call is stubbed.
  const actual = await importOriginal<typeof import("@/utils/nylas/client")>();
  return { ...actual, nylasFetch };
});

const GRANT_ID = "grant-1";
const logger = createTestLogger();

function contact(overrides: Record<string, unknown> = {}) {
  return {
    id: "contact-1",
    given_name: "Ada",
    surname: "Lovelace",
    display_name: null,
    company_name: null,
    emails: [{ type: "work", email: "ada@example.com" }],
    picture_url: null,
    ...overrides,
  };
}

describe("listNylasContacts", () => {
  beforeEach(() => {
    nylasFetch.mockReset();
  });

  it("reads one page and reports the next cursor", async () => {
    nylasFetch.mockResolvedValue({
      data: [contact()],
      next_cursor: "cursor-2",
    });

    const page = await listNylasContacts({ grantId: GRANT_ID });

    expect(page.contacts).toHaveLength(1);
    expect(page.nextCursor).toBe("cursor-2");
    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/contacts`,
      query: {
        limit: 200,
        page_token: undefined,
        search_query_native: undefined,
      },
    });
  });
});

describe("searchNylasContacts", () => {
  beforeEach(() => {
    nylasFetch.mockReset();
  });

  it("does not call the API for a blank query", async () => {
    await expect(
      searchNylasContacts({ grantId: GRANT_ID, query: "   ", logger }),
    ).resolves.toEqual([]);
    expect(nylasFetch).not.toHaveBeenCalled();
  });

  it("passes the query through as provider syntax and maps the results", async () => {
    nylasFetch.mockResolvedValue({
      data: [
        contact({
          display_name: "Ada, Countess of Lovelace",
          picture_url: "https://example.com/ada.png",
        }),
        contact({
          id: "contact-2",
          given_name: null,
          surname: null,
          company_name: "Analytical Engines Ltd",
          emails: [{ email: "hello@engines.example.com" }],
        }),
      ],
    });

    const contacts = await searchNylasContacts({
      grantId: GRANT_ID,
      query: "ada",
      logger,
    });

    // The query is handed to the provider untouched: translating it here would
    // silently change what users' searches match.
    expect(nylasFetch).toHaveBeenCalledWith({
      path: `/grants/${GRANT_ID}/contacts`,
      query: {
        limit: 20,
        page_token: undefined,
        search_query_native: "ada",
      },
    });

    expect(contacts).toEqual([
      {
        emailAddress: "ada@example.com",
        name: "Ada, Countess of Lovelace",
        profilePictureUrl: "https://example.com/ada.png",
      },
      {
        emailAddress: "hello@engines.example.com",
        name: "Analytical Engines Ltd",
        profilePictureUrl: undefined,
      },
    ]);
  });

  it("expands several addresses on one contact and drops invalid ones", async () => {
    nylasFetch.mockResolvedValue({
      data: [
        contact({
          display_name: "Ada",
          emails: [
            { email: "ada@example.com" },
            { email: "not-an-email" },
            { email: "ADA@example.com" },
            { email: "" },
          ],
        }),
      ],
    });

    const contacts = await searchNylasContacts({
      grantId: GRANT_ID,
      query: "ada",
      logger,
    });

    // Invalid addresses are dropped before they reach the picker, and the two
    // spellings of the same address collapse to one suggestion.
    expect(contacts).toEqual([
      {
        emailAddress: "ada@example.com",
        name: "Ada",
        profilePictureUrl: undefined,
      },
    ]);
  });

  it("caps a chatty contact list at the picker limit", async () => {
    nylasFetch.mockResolvedValue({
      data: Array.from({ length: 15 }, (_, index) =>
        contact({
          id: `contact-${index}`,
          display_name: `Person ${index}`,
          emails: [{ email: `person${index}@example.com` }],
        }),
      ),
    });

    const contacts = await searchNylasContacts({
      grantId: GRANT_ID,
      query: "person",
      logger,
    });

    expect(contacts).toHaveLength(10);
  });

  it("treats a grant without the contacts scope as having no suggestions", async () => {
    nylasFetch.mockRejectedValue(
      new NylasApiError({ status: 403, message: "Forbidden" }),
    );

    // Compose must still work: the user can type an address.
    await expect(
      searchNylasContacts({ grantId: GRANT_ID, query: "ada", logger }),
    ).resolves.toEqual([]);
  });

  it("surfaces any other failure rather than pretending there are no contacts", async () => {
    nylasFetch.mockRejectedValue(
      new NylasApiError({ status: 500, message: "Server error" }),
    );

    await expect(
      searchNylasContacts({ grantId: GRANT_ID, query: "ada", logger }),
    ).rejects.toBeInstanceOf(NylasApiError);
  });
});

describe("listNylasContactPhotos", () => {
  beforeEach(() => {
    nylasFetch.mockReset();
  });

  it("keys photos by canonical address and skips contacts without one", async () => {
    nylasFetch.mockResolvedValue({
      data: [
        contact({
          id: "with-photo",
          display_name: "Ada",
          emails: [{ email: "Ada@Example.com" }],
          picture_url: "https://example.com/ada.png",
        }),
        contact({
          id: "no-photo",
          emails: [{ email: "grace@example.com" }],
          picture_url: null,
        }),
        contact({
          id: "no-email",
          emails: [],
          picture_url: "https://example.com/orphan.png",
        }),
      ],
      next_cursor: null,
    });

    await expect(
      listNylasContactPhotos({ grantId: GRANT_ID }),
    ).resolves.toEqual({ "ada@example.com": "https://example.com/ada.png" });
  });

  it("keeps the first photo it sees for an address", async () => {
    nylasFetch.mockResolvedValue({
      data: [
        contact({
          id: "first",
          emails: [{ email: "ada@example.com" }],
          picture_url: "https://example.com/first.png",
        }),
        contact({
          id: "second",
          emails: [{ email: "ada@example.com" }],
          picture_url: "https://example.com/second.png",
        }),
      ],
      next_cursor: null,
    });

    const photos = await listNylasContactPhotos({ grantId: GRANT_ID });

    expect(photos["ada@example.com"]).toBe("https://example.com/first.png");
  });

  it("follows the cursor until the last page", async () => {
    nylasFetch
      .mockResolvedValueOnce({
        data: [
          contact({
            emails: [{ email: "ada@example.com" }],
            picture_url: "https://example.com/ada.png",
          }),
        ],
        next_cursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [
          contact({
            id: "contact-2",
            emails: [{ email: "grace@example.com" }],
            picture_url: "https://example.com/grace.png",
          }),
        ],
        next_cursor: null,
      });

    const photos = await listNylasContactPhotos({ grantId: GRANT_ID });

    expect(Object.keys(photos).sort()).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
    expect(nylasFetch.mock.calls[1][0].query.page_token).toBe("page-2");
  });

  it("surfaces an unpermitted grant instead of an empty map", async () => {
    nylasFetch.mockRejectedValue(
      new NylasApiError({ status: 403, message: "Forbidden" }),
    );

    // Swallowing this would cache `{}` for 24 hours as "no photos", so a merely
    // unpermitted grant would stay photo-less for a day after access is granted.
    await expect(
      listNylasContactPhotos({ grantId: GRANT_ID }),
    ).rejects.toBeInstanceOf(NylasApiError);
  });
});
