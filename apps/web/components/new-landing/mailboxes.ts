import {
  getProviderCapabilities,
  type ProviderFamily,
} from "@/utils/email/provider-registry";

export type Mailbox = {
  family: ProviderFamily;
  /** Name shown on the landing page. */
  name: string;
  /** Short name for the compact hero row. */
  shortName: string;
  /** Monogram drawn inside the mark. */
  mark: string;
  /** Brand colour of the mark. */
  color: string;
  /** How a mailbox of this family is connected. */
  connect: string;
  /** The family organises mail with labels rather than folders. */
  labels: boolean;
  /** Can act on every message from a sender in one call. */
  bulkActions: boolean;
  /** Can compose a reply draft from the in-app reader. */
  viewerReplies: boolean;
};

const MAILBOX_DEFINITIONS: Omit<
  Mailbox,
  "labels" | "bulkActions" | "viewerReplies"
>[] = [
  {
    family: "google",
    name: "Gmail & Google Workspace",
    shortName: "Gmail",
    mark: "G",
    color: "#EA4335",
    connect: "Sign in with Google",
  },
  {
    family: "microsoft",
    name: "Outlook & Microsoft 365",
    shortName: "Outlook",
    mark: "O",
    color: "#0F6CBD",
    connect: "Sign in with Microsoft",
  },
  {
    family: "yahoo",
    name: "Yahoo Mail",
    shortName: "Yahoo",
    mark: "Y",
    color: "#6001D2",
    connect: "App password",
  },
  {
    family: "zoho",
    name: "Zoho Mail",
    shortName: "Zoho",
    mark: "Z",
    color: "#E4252A",
    connect: "App password",
  },
  {
    family: "fastmail",
    name: "Fastmail",
    shortName: "Fastmail",
    mark: "F",
    color: "#1B1B1B",
    connect: "App password",
  },
  {
    family: "icloud",
    name: "iCloud Mail",
    shortName: "iCloud",
    mark: "i",
    color: "#0071E3",
    connect: "App password",
  },
  {
    family: "imap",
    name: "Any IMAP server",
    shortName: "IMAP",
    mark: "IM",
    color: "#5B6472",
    connect: "App password",
  },
];

/**
 * The mailbox families the app can connect, with the capabilities each one
 * really has. The capability flags come from the provider registry rather than
 * being restated here, so the landing page cannot drift from the product.
 */
export const MAILBOXES: Mailbox[] = MAILBOX_DEFINITIONS.map((mailbox) => {
  const capabilities = getProviderCapabilities(mailbox.family);
  return {
    ...mailbox,
    labels: capabilities.labels,
    bulkActions: capabilities.bulkActions,
    viewerReplies: capabilities.viewerReplies,
  };
});
