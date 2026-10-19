import type { ProviderFamily } from "@/utils/email/provider-registry";

/**
 * Where each IMAP family lives, so the form can offer a preset instead of asking
 * a user for four hostnames.
 *
 * Every value comes from the provider's own help pages, which disagree on some
 * details:
 *
 * - **Zoho** documents `imap.zoho.com` / `smtp.zoho.com` for personal and free
 *   organisation accounts, and `imappro.zoho.com` / `smtppro.zoho.com` for paid
 *   domain accounts. The preset is the former; a domain account overrides it.
 *   Zoho also requires IMAP to be switched on in its own settings, and a newly
 *   signed-up free plan has no IMAP access at all.
 * - **Fastmail** requires an app password (a regular password is refused) and
 *   documents 993/465 as implicit TLS, with 587 only for STARTTLS-only clients.
 * - **Yahoo** documents 993 for IMAP and "465 or 587" for SMTP without saying
 *   which is implicit TLS, so this uses 465 and marks it secure.
 * - **iCloud** uses 587 with STARTTLS for SMTP.
 */
export type ImapPreset = {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /** Shown next to the password field, because the format differs per provider. */
  passwordHint: string;
};

export const IMAP_PRESETS: Partial<Record<ProviderFamily, ImapPreset>> = {
  zoho: {
    imapHost: "imap.zoho.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    smtpSecure: true,
    passwordHint:
      "A Zoho app password (12 digits, no spaces) if two-factor authentication is on; otherwise the account password. IMAP must be enabled in Zoho Mail settings, which free plans do not include.",
  },
  fastmail: {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecure: true,
    passwordHint:
      "A Fastmail app password (16 characters). A regular Fastmail password will not work.",
  },
  yahoo: {
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecure: true,
    passwordHint: "A Yahoo app password, generated under Account Security.",
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false,
    passwordHint:
      "An Apple app-specific password, which requires two-factor authentication on the Apple ID.",
  },
};

export const GENERIC_IMAP_PASSWORD_HINT =
  "Usually an app password rather than the password you sign in with.";

export function getImapPreset(family: ProviderFamily) {
  return IMAP_PRESETS[family] ?? null;
}
