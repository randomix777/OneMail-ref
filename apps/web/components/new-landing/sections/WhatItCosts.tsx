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
import { cn } from "@/utils";

type Row = {
  title: string;
  price: string;
  detail: string;
};

/**
 * What the two ways of running it cost.
 *
 * The self-hosted deployment is free because the deployment pays for its own
 * keys. The hosted one is free too, except for the two things that cost
 * somebody real money: Gmail, which has to be reached through Nylas, and the
 * tokens the assistant spends.
 */
const SELF_HOSTED: Row[] = [
  {
    title: "The client",
    price: "Free",
    detail:
      "Open source, and every feature is in it. No seat count, no feature gates, no time limit.",
  },
  {
    title: "Every mailbox",
    price: "Free",
    detail:
      "Outlook, Yahoo, Fastmail, iCloud, Zoho and any IMAP server connect straight to you. Gmail needs a Nylas key, and you bring it.",
  },
  {
    title: "The models",
    price: "Free",
    detail:
      "Point the assistant at the model provider you already use, and you pay them their price.",
  },
];

const HOSTED: Row[] = [
  {
    title: "The client",
    price: "Free",
    detail:
      "The same code, running for you. Nothing to install and nothing to keep up to date.",
  },
  {
    title: "Every mailbox but Gmail",
    price: "Free",
    detail:
      "Outlook, Yahoo, Fastmail, iCloud, Zoho and any IMAP server cost us nothing, so they cost you nothing.",
  },
  {
    title: "Gmail",
    price: "Charged",
    detail:
      "Gmail is the exception. Holding Google's restricted scopes means that connection runs through Nylas, and we pass that cost on rather than hiding it in a seat price.",
  },
  {
    title: "The models",
    price: "Per token",
    detail:
      "Assistant calls go through the JYI gateway, and you pay for the tokens the model uses. Nothing for the mail itself.",
  },
];

function CostCard({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: Row[];
}) {
  return (
    <CardWrapper>
      <Card variant="extra-rounding" className="h-full">
        <CardContent>
          <h3 className="font-title text-xl leading-7 text-[#242424]">
            {title}
          </h3>
          <Paragraph size="sm" className="mt-2">
            {description}
          </Paragraph>
          <ul className="mt-6 space-y-5 border-t border-[#EFEFEF] pt-5">
            {rows.map((row) => (
              <li key={row.title} className="flex gap-4">
                <div className="w-24 shrink-0">
                  <div className="font-title text-[15px] leading-6 text-[#242424]">
                    {row.title}
                  </div>
                  <div
                    className={cn(
                      "text-[13px] leading-5",
                      row.price === "Free"
                        ? "text-new-green-600"
                        : "text-gray-500",
                    )}
                  >
                    {row.price}
                  </div>
                </div>
                <p className="text-[13px] leading-5 text-gray-500">
                  {row.detail}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </CardWrapper>
  );
}

export function WhatItCosts() {
  return (
    <Section id="pricing">
      <SectionHeading>What it actually costs</SectionHeading>
      <SectionSubtitle>
        The client is free. Two things cost somebody real money: Gmail, which
        has to be reached through Nylas, and the tokens the assistant spends.
      </SectionSubtitle>
      <SectionContent
        noMarginTop
        className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-2"
      >
        <CostCard
          title="If you run it yourself"
          description="You deploy it, you bring the keys, and there is nothing to pay for."
          rows={SELF_HOSTED}
        />
        <CostCard
          title="If we run it for you"
          description="Same client, hosted. Free, except where a third party makes it cost money."
          rows={HOSTED}
        />
      </SectionContent>
    </Section>
  );
}
