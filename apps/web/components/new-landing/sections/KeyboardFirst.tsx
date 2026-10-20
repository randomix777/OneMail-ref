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

/**
 * The keys the client answers to.
 *
 * These are the bindings the client really has, so the page cannot promise a
 * shortcut the product does not have.
 */
const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ["J", "K"], action: "Next and previous message" },
  { keys: ["E"], action: "Archive" },
  { keys: ["S"], action: "Star" },
  { keys: ["U"], action: "Mark as unread" },
  { keys: ["H"], action: "Snooze" },
  { keys: ["R"], action: "Reply" },
  { keys: ["#"], action: "Delete" },
  { keys: ["Z"], action: "Undo the last action" },
  { keys: ["/"], action: "Search" },
  { keys: ["⌘", "K"], action: "Command palette" },
];

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-[6px] border border-[#E3E3E3] bg-white px-1.5 font-geist text-[11px] font-medium text-gray-600 shadow-[0px_1px_0px_0px_#E3E3E3]">
      {children}
    </kbd>
  );
}

export function KeyboardFirst() {
  return (
    <Section>
      <SectionHeading>Your hands stay on the keyboard</SectionHeading>
      <SectionSubtitle>
        Everything you do to a message has a key, and the help dialog is
        generated from the same registry the keys are bound in.
      </SectionSubtitle>
      <SectionContent
        noMarginTop
        className="mt-10 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2"
      >
        {SHORTCUTS.map((shortcut) => (
          <div
            key={shortcut.action}
            className="flex items-center gap-3 border-b border-[#F0F0F0] pb-3"
          >
            <span className="flex w-24 shrink-0 items-center gap-1">
              {shortcut.keys.map((key) => (
                <Key key={key}>{key}</Key>
              ))}
            </span>
            <Paragraph size="sm" className="text-gray-600">
              {shortcut.action}
            </Paragraph>
          </div>
        ))}
      </SectionContent>
      <SectionContent className="mt-6 flex justify-center">
        <Paragraph size="sm" color="light" className={cn("text-center")}>
          Press <span className="font-medium text-gray-500">?</span> in the
          client for the full list.
        </Paragraph>
      </SectionContent>
    </Section>
  );
}
