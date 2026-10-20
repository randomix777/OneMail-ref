import { Card, CardContent } from "@/components/new-landing/common/Card";
import { CardWrapper } from "@/components/new-landing/common/CardWrapper";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  SectionHeading,
  SectionSubtitle,
} from "@/components/new-landing/common/Typography";

const REASONS = [
  {
    title: "Your mail, indexed locally",
    description:
      "A local database holds a copy of every mailbox, with a full-text index over subjects, senders and bodies. The list opens from that index, not from a round trip.",
  },
  {
    title: "One window for every mailbox",
    description:
      "Connect Gmail, Outlook, Yahoo, Fastmail, iCloud, Zoho or any IMAP server, and read them side by side in a single view that counts and searches across all of them.",
  },
  {
    title: "Built for the keyboard",
    description:
      "Moving, starring, archiving, snoozing and replying all have keys. The shortcut list and the command palette are generated from one registry, so a binding cannot exist without a label.",
  },
  {
    title: "Every action is undoable",
    description:
      "Archive, label, move, trash and spam are all reversible, from the toast or with a single key.",
  },
];

export function WhyAClient() {
  return (
    <Section>
      <SectionHeading>A client, not a wrapper</SectionHeading>
      <SectionSubtitle>
        The difference shows up in the first second: the list is already there,
        and it keeps working while the network does not.
      </SectionSubtitle>
      <SectionContent
        noMarginTop
        className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {REASONS.map((reason) => (
          <CardWrapper key={reason.title} padding="sm" rounded="sm">
            <Card variant="extra-rounding" className="h-full">
              <CardContent>
                <h3 className="font-title text-lg leading-6 text-[#242424]">
                  {reason.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-gray-500">
                  {reason.description}
                </p>
              </CardContent>
            </Card>
          </CardWrapper>
        ))}
      </SectionContent>
    </Section>
  );
}
