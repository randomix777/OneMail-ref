import type { MailTransport } from "@/utils/email/provider-registry";

/**
 * Whether a mailbox has something to authenticate with on its transport.
 *
 * Each transport stores a different credential, so a single "has a token?" test
 * is wrong for two of the three: a Nylas mailbox is identified by its grant id and
 * an IMAP mailbox by an app password. Checking tokens for either of those skipped
 * every message they delivered.
 */
export function hasTransportCredentials({
  transport,
  providerAccountId,
  accessToken,
  refreshToken,
  mailboxCredential,
}: {
  transport: MailTransport;
  providerAccountId?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  mailboxCredential?: { active: boolean } | null;
}): boolean {
  switch (transport) {
    case "imap":
      // The secret itself lives encrypted in the same row; an inactive credential
      // is one the user disconnected.
      return mailboxCredential?.active === true;
    case "nylas":
      // Nylas holds the tokens; all we keep is the grant id.
      return Boolean(providerAccountId);
    case "oauth":
      return Boolean(accessToken && refreshToken);
  }
}
