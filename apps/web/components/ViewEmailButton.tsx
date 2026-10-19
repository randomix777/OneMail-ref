import { MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import { Tooltip } from "@/components/Tooltip";

/**
 * Opens the message in the in-app reader.
 *
 * Available for every provider: the reader loads the thread through the provider
 * interface, so an IMAP mailbox reads here just as a Gmail one does. It used to be
 * Gmail-only, which left the IMAP families with no way to read a message inside
 * the app — and, for them, no web link to fall back on either.
 */
export function ViewEmailButton({
  threadId,
  messageId,
  className,
  size,
}: {
  threadId: string;
  messageId: string;
  className?: string;
  size?: "icon" | "xs" | "sm";
}) {
  const { showEmail } = useDisplayedEmail();

  return (
    <Tooltip content="View email">
      <Button
        variant="outline"
        size={size || "icon"}
        onClick={() => showEmail({ threadId, messageId })}
        className={className}
      >
        <MailIcon className="h-4 w-4" />
        <span className="sr-only">View email</span>
      </Button>
    </Tooltip>
  );
}
