import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import { BulkArchive } from "@/app/(app)/[emailAccountId]/bulk-archive/BulkArchive";
import { MutedText } from "@/components/Typography";
import { PageHeader } from "@/components/PageHeader";
import prisma from "@/utils/prisma";
import { getProviderCapabilities } from "@/utils/email/provider-registry";

export default async function BulkArchivePage({
  params,
}: {
  params: Promise<{ emailAccountId: string }>;
}) {
  const { emailAccountId } = await params;

  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { account: { select: { provider: true } } },
  });

  // Every action on this page archives or trashes every message from a sender in
  // one call, which a plain IMAP mailbox has no operation for. Offering the
  // screen would mean offering buttons that always fail, so it says why instead.
  const { bulkActions } = getProviderCapabilities(
    account?.account.provider ?? "",
  );
  if (!bulkActions) return <BulkArchiveUnavailable />;

  return (
    <>
      <PermissionsCheck />
      <BulkArchive />
    </>
  );
}

function BulkArchiveUnavailable() {
  return (
    <div className="mx-auto max-w-2xl py-8 text-center">
      <PageHeader title="Bulk archive" />
      <MutedText className="mx-auto mt-3 max-w-xl">
        Bulk actions are not available for this mailbox. Archiving or trashing
        every message from a sender in a single call needs a provider API that a
        plain IMAP connection does not offer.
      </MutedText>
      <MutedText className="mx-auto mt-3 max-w-xl">
        You can still archive and trash individual messages and whole threads
        from the mail view.
      </MutedText>
    </div>
  );
}
