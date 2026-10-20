import Link from "next/link";
import { Button } from "@/components/new-landing/common/Button";
import { BlurFade } from "@/components/new-landing/common/BlurFade";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  PageHeading,
  Paragraph,
} from "@/components/new-landing/common/Typography";
import type { Audience } from "@/components/new-landing/audiences";

/**
 * The page for one audience.
 *
 * The audiences differ in what they need, not in what the product does, so
 * they share a layout and carry their own content.
 */
export function AudiencePage({ audience }: { audience: Audience }) {
  return (
    <>
      <Section className="mt-10 md:mt-16">
        <PageHeading>{audience.headline}</PageHeading>
        <BlurFade duration={0.4} delay={0.125 * 2}>
          <Paragraph size="lg" className="mx-auto mt-6 max-w-[640px]">
            {audience.subtitle}
          </Paragraph>
        </BlurFade>

        <SectionContent className="mt-12 md:mt-16">
          <div className="mx-auto grid max-w-[980px] grid-cols-1 gap-8 text-left md:grid-cols-3 md:gap-6">
            {audience.workflows.map((workflow, index) => (
              <BlurFade
                key={workflow.title}
                duration={0.4}
                delay={0.125 * (3 + index)}
              >
                <div>
                  <p className="font-mono text-xs text-gray-400">
                    0{index + 1}
                  </p>
                  <h2 className="mt-2 font-title text-lg leading-6 text-[#242424]">
                    {workflow.title}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-gray-500">
                    {workflow.description}
                  </p>
                </div>
              </BlurFade>
            ))}
          </div>
        </SectionContent>
      </Section>

      <Section className="py-6 md:py-10">
        <SectionContent className="mx-auto max-w-[980px]">
          <div className="rounded-[20px] border border-[#E7E7E7] bg-[#FCFCFC] p-8 text-left">
            <h2 className="font-title text-xl leading-7 text-[#242424]">
              Also worth having
            </h2>
            <ul className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3 md:gap-4">
              {audience.alsoUseful.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-sm leading-6 text-gray-600"
                >
                  <span
                    aria-hidden="true"
                    className="mt-2 size-1.5 shrink-0 rounded-full bg-gray-300"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </SectionContent>
      </Section>

      <Section className="py-10 md:py-16">
        <SectionContent className="flex flex-col items-center gap-4">
          <Button size="xl" asChild>
            <Link href="/login">
              <span className="relative z-10">Get started</span>
            </Link>
          </Button>
          <Paragraph size="sm" color="light">
            Free to self-host · every mailbox, one window
          </Paragraph>
        </SectionContent>
      </Section>
    </>
  );
}
