import type { Metadata } from "next";
import Link from "next/link";
import { BasicLayout } from "@/components/layouts/BasicLayout";
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
import { BRAND_NAME, getBrandTitle } from "@/utils/branding";

const CAPABILITIES = [
  {
    title: "SAML single sign-on",
    description:
      "Sign in through Okta, Entra ID or Google Workspace. The identity provider is registered for your organisation, and the sign-in button appears in the app.",
  },
  {
    title: "SCIM provisioning",
    description:
      "Create and deactivate accounts from your directory. Deprovisioning revokes the person's sessions and blocks them from signing back in.",
  },
  {
    title: "Roles that mean something",
    description:
      "Owner, admin and member. Admins see the organisation's rules and analytics, manage members, and own the billing; members see their own mail.",
  },
  {
    title: "Rules for the whole team",
    description:
      "An organisation rule is written once and reaches every member, so the team files mail the same way without anyone copying a rule by hand.",
  },
  {
    title: "An API and an MCP server",
    description:
      "A versioned REST API with scoped keys, and an MCP server that lets your own agents browse the mailbox and act on it. Both are switches you turn on per deployment.",
  },
  {
    title: "Run it yourself",
    description:
      "Docker Compose, Kubernetes with the bundled Helm chart, or AWS with Copilot, ECS or a generated Terraform configuration.",
  },
];

export const metadata: Metadata = {
  title: getBrandTitle("Enterprise"),
  description: `SSO, SCIM, organisation roles and self-hosting for ${BRAND_NAME}.`,
  alternates: { canonical: "/enterprise" },
};

export default function EnterprisePage() {
  return (
    <BasicLayout>
      <Section className="mt-10 md:mt-16">
        <PageHeading>Your mail, on your terms, for your whole team</PageHeading>
        <BlurFade duration={0.4} delay={0.125 * 2}>
          <Paragraph size="lg" className="mx-auto mt-6 max-w-[640px]">
            {BRAND_NAME} gives a team one client for every mailbox it already
            has, and gives your administrators the controls they expect: single
            sign-on, directory provisioning, roles and rules.
          </Paragraph>
        </BlurFade>

        <SectionContent className="mt-12 md:mt-16">
          <div className="mx-auto grid max-w-[980px] grid-cols-1 gap-8 text-left md:grid-cols-3 md:gap-6">
            {CAPABILITIES.map((capability, index) => (
              <BlurFade
                key={capability.title}
                duration={0.4}
                delay={0.125 * (3 + index)}
              >
                <div>
                  <p className="font-mono text-xs text-gray-400">
                    0{index + 1}
                  </p>
                  <h2 className="mt-2 font-title text-lg leading-6 text-[#242424]">
                    {capability.title}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-gray-500">
                    {capability.description}
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
              Where your data sits
            </h2>
            <p className="mt-3 text-sm leading-6 text-gray-600">
              In a self-hosted deployment the mail itself, the credentials and
              the local index stay in your infrastructure. What leaves is what
              you send it to: the model provider you configure for the
              assistant, the mail server that holds the mailbox, and whatever
              you connect with Slack, Telegram or the API.
            </p>
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
            Free to run · SSO, SCIM and the API are deployment switches
          </Paragraph>
        </SectionContent>
      </Section>
    </BasicLayout>
  );
}
