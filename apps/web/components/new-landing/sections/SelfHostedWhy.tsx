import { Card, CardContent } from "@/components/new-landing/common/Card";
import { CardWrapper } from "@/components/new-landing/common/CardWrapper";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  Paragraph,
  SectionHeading,
  SectionSubtitle,
} from "@/components/new-landing/common/Typography";
import { Envelope } from "@/components/new-landing/icons/Envelope";
import { SnowFlake } from "@/components/new-landing/icons/SnowFlake";
import { Sparkle } from "@/components/new-landing/icons/Sparkle";
import { Team } from "@/components/new-landing/icons/Team";
import { MAILBOXES } from "@/components/new-landing/mailboxes";
import { BRAND_NAME } from "@/utils/branding";

const REASONS = [
  {
    title: "Open source",
    description:
      "AGPL licensed, and the whole stack is in the repository. Read it, fork it, run it wherever you like.",
    icon: <Sparkle size={24} />,
  },
  {
    title: "Your mail stays yours",
    description:
      "Messages, drafts and assistant context live on your own infrastructure. Nothing is used to train a model.",
    icon: (
      <span className="text-new-blue-600 [&>svg]:size-6">
        <SnowFlake />
      </span>
    ),
  },
  {
    title: "Every mailbox, one assistant",
    description: `${MAILBOXES.length} mailbox families, connected side by side and triaged together.`,
    icon: (
      <span className="text-new-green-600 [&>svg]:size-6">
        <Envelope />
      </span>
    ),
  },
  {
    title: "No per-seat pricing",
    description:
      "One instance for the whole team. There is no charge per mailbox and no charge per user.",
    icon: (
      <span className="text-new-orange-600 [&>svg]:size-6">
        <Team />
      </span>
    ),
  },
];

export function SelfHostedWhy() {
  return (
    <Section>
      <SectionHeading>Why run it yourself</SectionHeading>
      <SectionSubtitle>
        {BRAND_NAME} is built to live on your own servers: the code is open, the
        data never leaves, and the only limits are the ones you set.
      </SectionSubtitle>
      <SectionContent
        noMarginTop
        className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {REASONS.map((reason) => (
          <CardWrapper key={reason.title} padding="sm" rounded="sm">
            <Card variant="extra-rounding" className="h-full">
              <CardContent>
                <div className="flex size-10 items-center justify-center rounded-[10px] bg-gray-50">
                  {reason.icon}
                </div>
                <h3 className="mt-4 font-title text-lg leading-6 text-[#242424]">
                  {reason.title}
                </h3>
                <Paragraph size="sm" className="mt-2">
                  {reason.description}
                </Paragraph>
              </CardContent>
            </Card>
          </CardWrapper>
        ))}
      </SectionContent>
    </Section>
  );
}
