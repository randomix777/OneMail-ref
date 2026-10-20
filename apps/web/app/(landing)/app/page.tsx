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
          <Paragraph size="lg" className="mx-auto mt-6 max-w-[640px]">
            The same mail client, packaged as a desktop app for macOS and
            Windows. Your mailboxes, your splits, your keys, with its own window
            per account.
          </Paragraph>
        </BlurFade>
        <SectionContent className="mt-8 md:mt-10">
          <BlurFade duration={0.4} delay={0.125 * 4}>
            <Button size="xl" asChild>
              <Link href={DESKTOP_RELEASES_URL}>
                <span className="relative z-10">
                  Download for macOS or Windows
                </span>
              </Link>
            </Button>
          </BlurFade>
          <BlurFade duration={0.4} delay={0.125 * 5}>
            <Paragraph color="light" size="sm" className="mt-5">
              Free to download.
            </Paragraph>
          </BlurFade>
        </SectionContent>
      </Section>
    </BasicLayout>
  );
}
