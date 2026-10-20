import { Card, CardContent } from "@/components/new-landing/common/Card";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  SectionHeading,
  SectionSubtitle,
} from "@/components/new-landing/common/Typography";
import { Calendar } from "@/components/new-landing/icons/Calendar";
import { Newsletter } from "@/components/new-landing/icons/Newsletter";
import { Sparkle } from "@/components/new-landing/icons/Sparkle";

const HIGHLIGHTS = [
  {
    title: "Triage that runs itself",
    description:
      "Mail is labelled, archived and answered in your tone while you do something else.",
    icon: <Sparkle size={24} />,
  },
  {
    title: "Cleanup in one click",
    description:
      "Unsubscribe from a newsletter or archive everything from a noisy sender at once.",
    icon: (
      <span className="text-new-orange-600 [&>svg]:size-6">
        <Newsletter />
      </span>
    ),
  },
  {
    title: "Replies that fit your day",
    description:
      "Your calendar is read before a draft is written, so the reply lands at a time you can answer.",
    icon: (
      <span className="text-new-green-600 [&>svg]:size-6">
        <Calendar />
      </span>
    ),
  },
];

export function SelfHostedHighlights() {
  return (
    <Section className="mt-6 md:mt-10">
      <SectionHeading>What it does for you</SectionHeading>
      <SectionSubtitle>
        The assistant works in the background of the mailbox you already have.
      </SectionSubtitle>
      <SectionContent
        noMarginTop
        className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3"
      >
        {HIGHLIGHTS.map((highlight) => (
          <Card key={highlight.title} variant="extra-rounding">
            <CardContent>
              <div className="flex size-10 items-center justify-center rounded-[10px] bg-gray-50">
                {highlight.icon}
              </div>
              <h3 className="mt-4 font-title text-lg leading-6 text-[#242424]">
                {highlight.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-gray-500">
                {highlight.description}
              </p>
            </CardContent>
          </Card>
        ))}
      </SectionContent>
    </Section>
  );
}
