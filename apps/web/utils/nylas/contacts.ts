import { canonicalizeEmailAddress } from "@/utils/email";
import {
  MAX_CONTACT_RESULTS,
  normalizeContactCandidates,
  type EmailContact,
} from "@/utils/email/contact";
import type { Logger } from "@/utils/logger";
import { isNylasErrorWithStatus, nylasFetch } from "@/utils/nylas/client";

/** Nylas caps `limit` at 200, and pages with `next_cursor`. */
const CONTACT_PAGE_SIZE = 200;

/** Bounds both the walk and the payload the browser caches. */
const MAX_PHOTO_PAGES = 5;
const MAX_CONTACT_PHOTOS = 2000;

/**
 * Asking for more than we return leaves room to de-duplicate: one contact can
 * carry several addresses, and the picker de-dupes by address.
 */
const SEARCH_FETCH_LIMIT = MAX_CONTACT_RESULTS * 2;

export type NylasContact = {
  id: string;
  given_name?: string | null;
  surname?: string | null;
  display_name?: string | null;
  company_name?: string | null;
  emails?: Array<{ type?: string | null; email?: string | null }> | null;
  picture_url?: string | null;
};

/**
 * Contacts for the compose picker.
 *
 * `search_query_native` is passed through untouched, so for a Google grant the
 * provider's own syntax applies — the same reason mail search hands the query
 * over rather than translating it.
 *
 * A grant whose connector lacks the contacts scopes answers 403. That is a
 * missing feature, not a failure, so it yields no suggestions: compose still
 * works and the user can type an address.
 */
export async function searchNylasContacts({
  grantId,
  query,
  logger,
}: {
  grantId: string;
  query: string;
  logger: Logger;
}): Promise<EmailContact[]> {
  const searchQuery = query.trim();
  if (!searchQuery) return [];

  try {
    const { contacts } = await listNylasContacts({
      grantId,
      searchQueryNative: searchQuery,
      limit: SEARCH_FETCH_LIMIT,
    });

    return normalizeContactCandidates(contacts.flatMap(toContactCandidates));
  } catch (error) {
    if (!isContactsNotPermitted(error)) throw error;

    logger.info("Nylas contacts are not permitted for this grant", { grantId });
    return [];
  }
}

/**
 * Contact photos keyed by canonical email, for the inbox and reader avatars.
 *
 * Nylas has no "other contacts" source to merge: for a Google grant the provider
 * decides which address books `source` covers, so one walk is all there is.
 *
 * A 403 is deliberately *not* swallowed the way the search path swallows it. The
 * caller caches an empty map for 24 hours as "this account has no photos", and a
 * grant that is merely missing the contacts scope would be stuck with that for a
 * day; letting the error through routes it to the short-lived failed-sweep cache
 * instead, so newly granted access takes effect in minutes.
 */
export async function listNylasContactPhotos({
  grantId,
}: {
  grantId: string;
}): Promise<Record<string, string>> {
  const photos: Record<string, string> = {};
  let count = 0;
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PHOTO_PAGES; page++) {
    const { contacts, nextCursor } = await listNylasContacts({
      grantId,
      limit: CONTACT_PAGE_SIZE,
      pageToken,
    });

    for (const contact of contacts) {
      const photoUrl = contact.picture_url;
      if (!photoUrl) continue;

      for (const email of contact.emails ?? []) {
        if (!email.email) continue;
        const key = canonicalizeEmailAddress(email.email);
        if (!key || photos[key]) continue;

        photos[key] = photoUrl;
        count++;
        if (count === MAX_CONTACT_PHOTOS) return photos;
      }
    }

    if (!nextCursor) break;
    pageToken = nextCursor;
  }

  return photos;
}

export async function listNylasContacts({
  grantId,
  searchQueryNative,
  limit = CONTACT_PAGE_SIZE,
  pageToken,
}: {
  grantId: string;
  searchQueryNative?: string;
  limit?: number;
  pageToken?: string;
}) {
  const response = await nylasFetch<{
    data?: NylasContact[];
    next_cursor?: string | null;
  }>({
    path: `/grants/${grantId}/contacts`,
    query: {
      limit,
      page_token: pageToken,
      search_query_native: searchQueryNative,
    },
  });

  return {
    contacts: response.data ?? [],
    nextCursor: response.next_cursor ?? null,
  };
}

/** Nylas' contacts reads answer 403 when the grant's connector lacks the scope. */
function isContactsNotPermitted(error: unknown) {
  return isNylasErrorWithStatus(error, 403);
}

function toContactCandidates(contact: NylasContact): EmailContact[] {
  const name = contactName(contact);
  const profilePictureUrl = contact.picture_url ?? undefined;

  return (contact.emails ?? []).flatMap(({ email }) =>
    email ? [{ emailAddress: email, name, profilePictureUrl }] : [],
  );
}

function contactName(contact: NylasContact) {
  const fullName = [contact.given_name, contact.surname]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  const name =
    contact.display_name?.trim() ||
    fullName ||
    contact.company_name?.trim() ||
    "";

  return name || undefined;
}
