import { canGenerateMessageUrl, getEmailUrlForMessage } from "@/utils/url";

type GetEmailMessageCellActionsOptions = {
  externalUrl?: string;
  hideViewEmailButton?: boolean;
  messageId: string;
  provider?: string;
  threadId: string;
  userEmail?: string | null;
};

export function getEmailMessageCellActions({
  externalUrl,
  hideViewEmailButton,
  messageId,
  provider,
  threadId,
  userEmail,
}: GetEmailMessageCellActionsOptions) {
  if (hideViewEmailButton) return null;

  // `externalUrl` is the provider's own link, when the message carries one (Graph
  // does). Otherwise a link is only generated for a provider whose generated form
  // is trustworthy; the builder's fallback is Gmail's shape, so asking it about an
  // IMAP mailbox would produce a link to Gmail carrying someone else's id. Those
  // mailboxes read in the app instead.
  const openUrl =
    externalUrl ||
    (canGenerateMessageUrl(provider)
      ? getEmailUrlForMessage(messageId, threadId, userEmail, provider)
      : undefined);

  return {
    openUrl,
    showViewEmailButton: true,
  };
}
