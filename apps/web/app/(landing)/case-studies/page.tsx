import type { Metadata } from "next";
import Link from "next/link";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { BlurFade } from "@/components/new-landing/common/BlurFade";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  PageHeading,
  Paragraph,
} from "@/components/new-landing/common/Typography";
import { AUDIENCES } from "@/components/new-landing/audiences";
import { MailboxMark } from "@/components/new-landing/MailboxMark";
import { MAILBOXES } from "@/components/new-landing/mailboxes";
import { BRAND_NAME, getBrandTitle } from "@/utils/branding";

export const metadata: Metadata = {
  title: getBrandTitle("Use cases"),
  description: `How ${BRAND_NAME} is used by founders, small businesses, creators, agents, support teams and online shops.`,
  alternates: { canonical: "/case-studies" },
};

export default function CaseStudiesPage() {
  return (
    <BasicLayout>
      <Section className="mt-10 md:mt-16">
        <PageHeading>Six kinds of inbox, one client</PageHeading>
        <BlurFade duration={0.4} delay={0.125 * 2}>
          <Paragraph size="lg" className="mx-auto mt-6 max-w-[640px]">
            The client is the same for all of them. What changes is which
            workflows you lean on.
          </Paragraph>
        </BlurFade>

        <SectionContent className="mt-12 md:mt-16">
          <div className="mx-auto grid max-w-[980px] grid-cols-1 gap-4 text-left sm:grid-cols-2 md:grid-cols-3">
            {AUDIENCES.map((audience, index) => (
              <BlurFade
                key={audience.slug}
                duration={0.4}
                delay={0.125 * (3 + index)}
              >
                <Link
                  href={`/${audience.slug}`}
                  className="block h-full rounded-[20px] border border-[#E7E7E7] bg-white p-6 transition-colors hover:border-[#D4D4D4]"
                >
                  <h2 className="font-title text-lg leading-6 text-[#242424]">
                    {audience.title}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-gray-500">
                    {audience.subtitle}
                  </p>
                </Link>
              </BlurFade>
            ))}
          </div>
        </SectionContent>
      </Section>

      <Section className="py-6 md:py-10">
        <SectionContent className="mx-auto max-w-[980px]">
          <div className="rounded-[20px] border border-[#E7E7E7] bg-[#FCFCFC] p-8 text-left">
            <h2 className="font-title text-xl leading-7 text-[#242424]">
              Whatever the work, it starts in the mailbox
            </h2>
            <p className="mt-3 text-sm leading-6 text-gray-600">
              Every one of these runs on the same set of providers.
            </p>
            <ul className="mt-5 flex flex-wrap gap-2">
              {MAILBOXES.map((mailbox) => (
                <li
                  key={mailbox.family}
                  className="flex items-center gap-1.5 rounded-full border border-[#E7E7E7] bg-white py-1 pr-3 pl-1"
                >
                  <MailboxMark
                    mark={mailbox.mark}
                    color={mailbox.color}
                    className="size-5 text-[10px]"
                  />
                  <span className="text-xs font-medium text-gray-600">
                    {mailbox.shortName}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </SectionContent>
      </Section>
    </BasicLayout>
  );
}
