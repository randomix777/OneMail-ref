import { z } from "zod";
import { PROVIDER_FAMILIES } from "@/utils/email/provider-registry";

/** Only the families reachable over IMAP are connectable this way. */
const IMAP_FAMILIES = PROVIDER_FAMILIES.filter(
  (family) => family !== "google" && family !== "microsoft",
);

const host = z.string().trim().min(1).max(255);
const port = z.coerce.number().int().min(1).max(65_535);

/**
 * Connecting a mailbox with an app password.
 *
 * The host fields are optional because a preset supplies them; `imap` has no
 * preset, so the form asks for them and this schema is what requires them.
 */
export const connectImapMailboxBody = z
  .object({
    provider: z.enum(IMAP_FAMILIES as [string, ...string[]]),
    email: z.string().trim().email(),
    username: z.string().trim().min(1).max(320).optional(),
    secret: z.string().min(1).max(1024),
    imapHost: host.optional(),
    imapPort: port.optional(),
    imapSecure: z.boolean().optional(),
    smtpHost: host.optional(),
    smtpPort: port.optional(),
    smtpSecure: z.boolean().optional(),
  })
  .refine(
    (value) =>
      // A preset covers the named families; the generic one has to be filled in.
      value.provider !== "imap" ||
      (value.imapHost && value.smtpHost && value.imapPort && value.smtpPort),
    {
      message:
        "An IMAP server needs its IMAP and SMTP hostnames and ports spelled out.",
      path: ["imapHost"],
    },
  );

export type ConnectImapMailboxBody = z.infer<typeof connectImapMailboxBody>;
