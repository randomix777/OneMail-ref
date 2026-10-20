import Link from "next/link";
import { Card, CardContent } from "@/components/new-landing/common/Card";
import { CardWrapper } from "@/components/new-landing/common/CardWrapper";
import { Button } from "@/components/new-landing/common/Button";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  Paragraph,
  SectionHeading,
  SectionSubtitle,
} from "@/components/new-landing/common/Typography";
import { BRAND_NAME } from "@/utils/branding";

const COSTS = [
  {
    title: "The software",
    price: "$0",
    detail: "AGPL licensed. Every feature, no seat count, no feature gates.",
  },
  {
    title: "Your infrastructure",
    price: "Yours",
    detail:
      "A small machine is enough to start. Scale it, or keep it on a box you already own.",
  },
  {
    title: "Your model provider",
    price: "Yours",
    detail:
      "Bring the key for the provider you already use. You are billed by them, at their price.",
  },
];

export function SelfHostedPricing() {
  return (
    <Section id="pricing">
      <SectionHeading>What it actually costs</SectionHeading>
      <SectionSubtitle>
        {BRAND_NAME} is free to run. There is nothing to buy and no per-user
        pricing — you pay for the machine it runs on and the model provider you
        point it at.
      </SectionSubtitle>
      <SectionContent
        noMarginTop
        className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3"
      >
        {COSTS.map((cost) => (
          <CardWrapper key={cost.title}>
            <Card variant="extra-rounding" className="h-full">
              <CardContent>
                <Paragraph size="sm" color="gray-500">
                  {cost.title}
                </Paragraph>
                <div className="mt-2 font-title text-[2rem] leading-tight text-[#242424]">
                  {cost.price}
                </div>
                <Paragraph size="sm" className="mt-3">
                  {cost.detail}
                </Paragraph>
              </CardContent>
            </Card>
          </CardWrapper>
        ))}
      </SectionContent>
      <SectionContent className="mt-8 flex justify-center">
        <Button size="xl" asChild>
          <Link href="/login">
            <span className="relative z-10">Get started</span>
          </Link>
        </Button>
      </SectionContent>
    </Section>
  );
}
