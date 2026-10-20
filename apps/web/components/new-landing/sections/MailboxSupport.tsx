import { BlurFade } from "@/components/new-landing/common/BlurFade";
import { MailboxMark } from "@/components/new-landing/MailboxMark";
import { MAILBOXES, type Mailbox } from "@/components/new-landing/mailboxes";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  Paragraph,
  SectionHeading,
  SectionSubtitle,
} from "@/components/new-landing/common/Typography";
import { cn } from "@/utils";

function Capability({
  enabled,
  label,
  kind = "feature",
}: {
  /** Omitted for rows that describe the mailbox rather than a feature. */
  enabled?: boolean;
  label: string;
  kind?: "feature" | "model";
}) {
  const supported = enabled ?? true;

  return (
    <li
      className={cn(
        "flex items-center gap-1.5 text-[13px] leading-5",
        supported ? "text-gray-700" : "text-gray-400",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 items-center justify-center rounded-full text-[10px] font-semibold",
          kind === "model"
            ? "bg-new-blue-100 text-new-blue-600"
            : supported
              ? "bg-new-green-100 text-new-green-600"
              : "bg-gray-100 text-gray-400",
        )}
      >
        {kind === "model" ? "●" : supported ? "✓" : "–"}
      </span>
      {label}
    </li>
  );
}

function MailboxCard({ mailbox }: { mailbox: Mailbox }) {
  return (
    <div className="flex h-full flex-col rounded-[20px] border border-[#E7E7E780] bg-white p-6 text-left shadow-[0px_3px_12.9px_0px_#97979714]">
      <div className="flex items-center gap-3">
        <MailboxMark
          mark={mailbox.mark}
          color={mailbox.color}
          className="size-10 text-[15px]"
        />
        <div>
          <h3 className="min-h-12 font-title text-[17px] leading-6 text-[#242424]">
            {mailbox.name}
          </h3>
          <p className="mt-0.5 text-[13px] leading-5 text-gray-500">
            {mailbox.connect}
          </p>
        </div>
      </div>
      <ul className="mt-5 space-y-2 border-t border-[#EFEFEF] pt-4">
        <Capability
          kind="model"
          label={mailbox.labels ? "Gmail-style labels" : "Folders"}
        />
        <Capability
          enabled={mailbox.bulkActions}
          label="Bulk archive by sender"
        />
        <Capability enabled={mailbox.viewerReplies} label="Reply drafts" />
      </ul>
    </div>
  );
}

export function MailboxSupport() {
  return (
    <Section>
      <SectionHeading>Every mailbox you already have</SectionHeading>
      <SectionSubtitle>
        One assistant across Gmail, Outlook, Yahoo, Fastmail, iCloud, Zoho and
        any other IMAP server. Connect as many as you like and work from a
        single inbox.
      </SectionSubtitle>
      <SectionContent
        noMarginTop
        className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {MAILBOXES.map((mailbox, index) => (
          <BlurFade
            key={mailbox.family}
            delay={0.05 * index}
            inView
            className={cn(
              "h-full",
              // The catch-all IMAP card takes the two remaining columns so the
              // grid ends on a full row.
              mailbox.family === "imap" && "lg:col-span-2",
            )}
          >
            <MailboxCard mailbox={mailbox} />
          </BlurFade>
        ))}
      </SectionContent>
      <Paragraph size="sm" className="mt-6 text-gray-500">
        A dash means the mailbox has no equivalent operation, so that affordance
        is hidden rather than shown and failing. Everything else — triage,
        replies, digests, calendar — works the same way.
      </Paragraph>
    </Section>
  );
}
