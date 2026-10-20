import type { Metadata } from "next";
import Link from "next/link";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  PageHeading,
  Paragraph,
} from "@/components/new-landing/common/Typography";
import { Button } from "@/components/new-landing/common/Button";
import { BlurFade } from "@/components/new-landing/common/BlurFade";
import { BRAND_NAME, getBrandTitle } from "@/utils/branding";

const DESKTOP_RELEASES_URL =
  "https://github.com/randomix777/OneMail-ref/releases";

const PERKS = [
  {
    title: "Its own window per account",
    description:
      "Open a second mailbox in a second window, side by side with the first.",
  },
  {
    title: "The command palette",
    description: "Search, split, snooze and send without leaving the keyboard.",
  },
  {
    title: "Updates on its own",
    description:
      "The desktop app checks for new versions and offers them in the app menu.",
  },
];

export const metadata: Metadata = {
  title: getBrandTitle("Get the app"),
  description: `${BRAND_NAME} on macOS and Windows. The same mail client you use on the web, packaged for the desktop.`,
  alternates: { canonical: "/app" },
};

export default function AppPage() {
  return (
    <BasicLayout>
      <Section className="mt-10 md:mt-20">
        <PageHeading>{BRAND_NAME} for the desktop</PageHeading>
        <BlurFade duration={0.4} delay={0.125 * 2}>
          <Paragraph size="lg" className="mx-auto mt-6 max-w-[620px]">
            The same client, in a window of its own. It keeps the shortcuts, the
            splits and the local index, and it stays out of the browser tab
            jungle.
          </Paragraph>
        </BlurFade>

        <SectionContent className="mt-10 md:mt-14">
          <div className="mx-auto grid max-w-[900px] grid-cols-1 gap-6 text-left md:grid-cols-3">
            {PERKS.map((perk, index) => (
              <BlurFade
                key={perk.title}
                duration={0.4}
                delay={0.125 * (3 + index)}
              >
                <div>
                  <p className="font-mono text-xs text-gray-400">
                    0{index + 1}
                  </p>
                  <h2 className="mt-2 font-title text-lg leading-6 text-[#242424]">
                    {perk.title}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-gray-500">
                    {perk.description}
                  </p>
                </div>
              </BlurFade>
            ))}
          </div>
        </SectionContent>

        <SectionContent className="mt-12 flex flex-col items-center gap-3">
          <BlurFade duration={0.4} delay={0.125 * 6}>
            <Button size="xl" asChild>
              <Link href={DESKTOP_RELEASES_URL}>
                <span className="relative z-10">
                  Download for macOS or Windows
                </span>
              </Link>
            </Button>
          </BlurFade>
          <BlurFade duration={0.4} delay={0.125 * 7}>
            <Paragraph color="light" size="sm">
              Free to download.
            </Paragraph>
          </BlurFade>
        </SectionContent>
      </Section>
    </BasicLayout>
  );
}
