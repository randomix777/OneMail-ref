import type { ConnectImapMailboxBody } from "@/utils/actions/mailbox-credentials.validation";
import type { ProviderFamily } from "@/utils/email/provider-registry";
import { getImapPreset } from "@/utils/imap/presets";
import { SafeError } from "@/utils/error";

export type ResolvedConnection = {
  secret: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
};

export function resolveConnection({
  input,
  family,
}: {
  input: ConnectImapMailboxBody;
  family: ProviderFamily;
}): ResolvedConnection {
  const preset = getImapPreset(family);

  const imapHost = input.imapHost ?? preset?.imapHost;
  const imapPort = input.imapPort ?? preset?.imapPort;
  const smtpHost = input.smtpHost ?? preset?.smtpHost;
  const smtpPort = input.smtpPort ?? preset?.smtpPort;

  if (!imapHost || !imapPort || !smtpHost || !smtpPort) {
    throw new SafeError(
      "The mail server's IMAP and SMTP details are required for this provider.",
    );
  }

  return {
    secret: input.secret,
    imapHost,
    imapPort,
    imapSecure: preset ? preset.imapSecure : (input.imapSecure ?? true),
    smtpHost,
    smtpPort,
    smtpSecure: preset ? preset.smtpSecure : (input.smtpSecure ?? true),
    username: input.username ?? input.email,
  };
}
