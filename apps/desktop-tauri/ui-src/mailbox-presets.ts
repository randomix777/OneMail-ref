export type MailboxPreset = {
  id: string;
  label: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  passwordHint: string;
};

export const MAILBOX_PRESETS: MailboxPreset[] = [
  {
    id: "gmail",
    label: "Gmail / Google Workspace",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    passwordHint:
      "Use a Google app password. Turn on 2-Step Verification, then create one under Account → Security → App passwords.",
  },
  {
    id: "outlook",
    label: "Outlook / Microsoft 365",
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
    passwordHint:
      "Use an app password if your account has two-step verification. Your organization may also need to allow IMAP and SMTP AUTH.",
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    passwordHint: "Use a Yahoo app password from Account Security.",
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    passwordHint:
      "Use an Apple app-specific password. Two-factor authentication must be enabled on the Apple ID.",
  },
  {
    id: "zoho",
    label: "Zoho Mail",
    imap: { host: "imap.zoho.com", port: 993, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, secure: true },
    passwordHint:
      "Use a Zoho app password if two-factor authentication is on. IMAP must be enabled in Zoho Mail settings.",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    imap: { host: "imap.fastmail.com", port: 993, secure: true },
    smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
    passwordHint: "Use a Fastmail app password. A regular password will not work.",
  },
  {
    id: "other",
    label: "Other mail server",
    imap: { host: "", port: 993, secure: true },
    smtp: { host: "", port: 465, secure: true },
    passwordHint:
      "Usually an app password rather than the password you sign in with.",
  },
];

export function presetById(id: string): MailboxPreset {
  return MAILBOX_PRESETS.find((preset) => preset.id === id) ?? MAILBOX_PRESETS[0];
}
