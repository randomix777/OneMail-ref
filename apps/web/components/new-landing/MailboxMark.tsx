import { cn } from "@/utils";

interface MailboxMarkProps {
  className?: string;
  /** Brand colour of the mark. */
  color: string;
  /** Monogram drawn inside the mark. */
  mark: string;
}

/**
 * The provider badge used across the landing page. One shape for every mailbox
 * family, so a row of them reads as a set rather than as mixed vendor logos.
 */
export function MailboxMark({ mark, color, className }: MailboxMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[7px] font-title font-semibold text-white",
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {mark}
    </span>
  );
}
