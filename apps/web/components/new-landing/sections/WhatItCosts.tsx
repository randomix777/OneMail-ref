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
 * What running the product costs.
 *
 * The client is free. Two things are not: Google mailboxes, which are reached
 * through Nylas and billed per mailbox, and the tokens the assistant spends
 * through the JYI gateway.
 */
const COSTS: Row[] = [
  {
    title: "The client",
    price: "Free",
    detail:
      "Open source, and every feature is in it. No seat count, no feature gates, no time limit.",
  },
  {
    title: "Your mailboxes",
    price: "Free",
    detail:
      "Outlook, Yahoo, Fastmail, iCloud, Zoho and any IMAP server connect straight to us. There is nothing to buy.",
  },
  {
    title: "Google mail",
    price: "Per account",
    detail:
      "Google mail is reached through Nylas, because that is the only way to hold the scopes Google requires. Nylas bills per connected account, and each Google mailbox is billed at Nylas's own per-account rate, passed straight through.",
  },
  {
    title: "The assistant",
    price: "Per token",
    detail:
      "Assistant calls go through the JYI gateway, and you pay for the tokens the model uses. Nothing for the mail itself.",
  },
];

export function WhatItCosts() {
  return (
    <Section id="pricing">
      <SectionHeading>What it actually costs</SectionHeading>
      <SectionSubtitle>
        The client is free. Two things are not: Google mail, which is reached
        through Nylas and billed at Nylas's own per-account rate, and the tokens
        the assistant spends.
      </SectionSubtitle>
      <SectionContent noMarginTop className="mt-10">
        <CardWrapper>
          <Card variant="extra-rounding" className="h-full">
            <CardContent>
              <ul className="space-y-6">
                {COSTS.map((cost) => (
                  <li
                    key={cost.title}
                    className="flex flex-col gap-1 border-b border-[#EFEFEF] pb-6 last:border-0 last:pb-0 md:flex-row md:gap-8"
                  >
                    <div className="md:w-48 md:shrink-0">
                      <div className="font-title text-[15px] leading-6 text-[#242424]">
                        {cost.title}
                      </div>
                      <div
                        className={cn(
                          "text-[13px] leading-5",
                          cost.price === "Free"
                            ? "text-new-green-600"
                            : "text-gray-500",
                        )}
                      >
                        {cost.price}
                      </div>
                    </div>
                    <p className="text-[13px] leading-5 text-gray-500 md:flex-1">
                      {cost.detail}
                    </p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </CardWrapper>
      </SectionContent>
      <SectionContent className="mt-6 flex justify-center">
        <Paragraph size="sm" color="light" className="text-center">
          Running it yourself is free too. The assistant still runs on the JYI
          gateway, so you pay for the tokens it uses and nothing else.
        </Paragraph>
      </SectionContent>
    </Section>
  );
}
