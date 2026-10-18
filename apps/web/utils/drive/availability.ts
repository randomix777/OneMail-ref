import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import prisma from "@/utils/prisma";

/**
 * Whether this mailbox may connect a Drive for attachment filing.
 *
 * Nylas brokers mail, calendar and contacts — not Drive. A Google mailbox
 * reached through Nylas therefore has no drive at all, and filing to Google
 * Drive would mean our own OAuth client asking for
 * `https://www.googleapis.com/auth/drive.file` again, which is the CASA
 * obligation the Nylas transport exists to avoid. The feature is disabled for
 * those accounts rather than kept alive on a second client.
 *
 * OneDrive is unaffected: Microsoft mail is not on Nylas, so nothing changes
 * there.
 */
export function canUseDriveFiling({
  provider,
  transport,
}: {
  provider: string;
  transport: string;
}) {
  if (isMicrosoftProvider(provider)) return true;

  if (isGoogleProvider(provider)) return transport !== "nylas";

  return false;
}

/** The same answer for a mailbox, read from its account. */
export async function isDriveFilingAvailable(emailAccountId: string) {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: { select: { provider: true, transport: true } },
    },
  });

  if (!emailAccount) return false;

  return canUseDriveFiling(emailAccount.account);
}
