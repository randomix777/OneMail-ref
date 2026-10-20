import type { Metadata } from "next";
import { Hero, HeroContent } from "@/app/(landing)/home/Hero";
import { EverythingElseSection } from "@/components/new-landing/sections/EverythingElseSection";
import { StartedInMinutes } from "@/components/new-landing/sections/StartedInMinutes";
import { BulkUnsubscribe } from "@/components/new-landing/sections/BulkUnsubscribe";
import { OrganizedInbox } from "@/components/new-landing/sections/OrganizedInbox";
import { PreWrittenDrafts } from "@/components/new-landing/sections/PreWrittenDrafts";
import { ManageFromAnywhere } from "@/components/new-landing/sections/ManageFromAnywhere";
import {
  EMAIL_CLIENT_SECTION_ID,
  EmailClient,
} from "@/components/new-landing/sections/EmailClient";
import { MailboxSupport } from "@/components/new-landing/sections/MailboxSupport";
import { SelfHostedHighlights } from "@/components/new-landing/sections/SelfHostedHighlights";
import { SelfHostedPricing } from "@/components/new-landing/sections/SelfHostedPricing";
import { SelfHostedWhy } from "@/components/new-landing/sections/SelfHostedWhy";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { FAQs } from "@/app/(landing)/home/FAQs";
import { FinalCTA } from "@/app/(landing)/home/FinalCTA";
import { WordReveal } from "@/components/new-landing/common/WordReveal";
import { SectionLink } from "@/components/new-landing/common/SectionLink";
import { env } from "@/env";
import { BRAND_NAME } from "@/utils/branding";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function NewLanding() {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return (
      <BasicLayout>
        <Hero
          title={`${BRAND_NAME} for self-hosted teams`}
          subtitle={`Deploy ${BRAND_NAME} on your own infrastructure and automate your inbox with full data control. Works with Gmail, Outlook, Yahoo, Fastmail, iCloud, Zoho and any IMAP server.`}
        />
        <SelfHostedHighlights />
        <MailboxSupport />
      </BasicLayout>
    );
  }

  return (
    <BasicLayout>
      <Hero
        badge={
          <SectionLink sectionId={EMAIL_CLIENT_SECTION_ID}>
            New: {BRAND_NAME} Mail app →
          </SectionLink>
        }
        title={
          <WordReveal
            spaceBetween="w-2 md:w-3"
            words={[
              "Meet",
              "your",
              "AI",
              "email",
              "assistant",
              "that",
              <em key="actually">actually</em>,
              "works",
            ]}
          />
        }
        subtitle={`${BRAND_NAME} organizes your inbox and calendar, drafts replies in your voice, and helps you reach inbox zero fast. Never miss an important email again.`}
      >
        <HeroContent />
      </Hero>
      <MailboxSupport />
      <OrganizedInbox
        title={
          <>
            Automatically organized.
            <br /> Never miss an important email again.
          </>
        }
        subtitle="Drowning in emails? Don't waste energy trying to prioritize your emails. Our AI assistant will label everything automatically."
      />
      <PreWrittenDrafts
        title="Pre-written drafts waiting in your inbox"
        subtitle="When you check your inbox, every email needing a response will have a pre-drafted reply in your tone, ready for you to send."
      />
      <ManageFromAnywhere />
      <EmailClient />
      <StartedInMinutes
        title="Get started in minutes"
        subtitle="One-click setup. Start organizing and drafting replies in minutes."
      />
      <BulkUnsubscribe />
      <EverythingElseSection />
      <SelfHostedWhy />
      <SelfHostedPricing />
      <FinalCTA />
      <FAQs />
    </BasicLayout>
  );
}
