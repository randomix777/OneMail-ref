import { Anchor } from "@/components/new-landing/common/Anchor";
import { Card, CardContent } from "@/components/new-landing/common/Card";
import { CardWrapper } from "@/components/new-landing/common/CardWrapper";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  Paragraph,
  SectionHeading,
} from "@/components/new-landing/common/Typography";
import { env } from "@/env";
import { BRAND_NAME } from "@/utils/branding";

const faqs: {
  question: string;
  answer: React.ReactNode;
  answerText?: string;
}[] = [
  {
    question: `Which email providers does ${BRAND_NAME} support?`,
    answer:
      "Gmail and Google Workspace, Outlook and Microsoft 365, Yahoo Mail, Zoho Mail, Fastmail, iCloud Mail, and any other IMAP server. Google and Microsoft connect with a sign-in; the rest connect with an app password.",
  },
  {
    question: "How can I request a feature?",
    answer: (
      <span>
        Email us or post an issue on{" "}
        <Anchor href="/github" newTab>
          GitHub
        </Anchor>
        . We're happy to hear how we can improve your email experience.
      </span>
    ),
    answerText:
      "Email us or post an issue on GitHub. We're happy to hear how we can improve your email experience.",
  },
  {
    question: `Will ${BRAND_NAME} replace my current email app?`,
    answer: (
      <span>
        It doesn't have to. {BRAND_NAME} works alongside whichever mailbox you
        already use, so you can keep using it as normal while the assistant
        works in the background. {BRAND_NAME} also has its own{" "}
        <Anchor href="/email-client">email client</Anchor> for the web and
        desktop if you'd like to use it.
      </span>
    ),
    answerText: `It doesn't have to. ${BRAND_NAME} works alongside whichever mailbox you already use, so you can keep using it as normal while the assistant works in the background. ${BRAND_NAME} also has its own email client for the web and desktop if you'd like to use it.`,
  },
  {
    question: "Is there a mobile app?",
    answer: (
      <span>
        Not yet. The client runs on the web and on the desktop, and the
        assistant can reach you on Slack or Telegram while you are away. A
        mobile app is on the list, and we would rather say so than ship a
        promise.
      </span>
    ),
    answerText:
      "Not yet. The client runs on the web and on the desktop, and the assistant can reach you on Slack or Telegram while you are away. A mobile app is on the list, and we would rather say so than ship a promise.",
  },
  {
    question: "Is the code open-source?",
    answer: (
      <span>
        Yes! The mail client, the AI assistant and the desktop app are open
        source in our{" "}
        <Anchor href="/github" newTab>
          GitHub repo
        </Anchor>
        .
      </span>
    ),
    answerText:
      "Yes! The mail client, the AI assistant and the desktop app are open source in our GitHub repo.",
  },
  {
    question: "Do you offer refunds?",
    answer: (
      <span>
        Yes, if you don't think we provided you with value send us an{" "}
        <Anchor href={`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}`}>email</Anchor>{" "}
        within 14 days of upgrading and we'll refund you.
      </span>
    ),
    answerText:
      "Yes, if you don't think we provided you with value send us an email within 14 days of upgrading and we'll refund you.",
  },
  {
    question: `Can I try ${BRAND_NAME} for free?`,
    answer:
      "Yes. The client is free, and every mailbox except Google mail connects for free. The two things that cost money are Google mail, which is reached through Nylas and billed at Nylas's own rate once it is past the allowance, and the tokens the assistant spends through the JYI gateway.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs
    .map((faq) => {
      const text = typeof faq.answer === "string" ? faq.answer : faq.answerText;
      if (!text) return null;
      return {
        "@type": "Question" as const,
        name: faq.question,
        acceptedAnswer: { "@type": "Answer" as const, text },
      };
    })
    .filter(Boolean),
};

export function FAQs() {
  return (
    <Section>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify on controlled object is safe
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <SectionHeading>Frequently asked questions</SectionHeading>
      <SectionContent>
        <CardWrapper>
          <dl className="grid md:grid-cols-2 gap-6">
            {faqs.map((faq) => (
              <Card
                variant="extra-rounding"
                className="gap-4"
                key={faq.question}
              >
                <CardContent>
                  <Paragraph
                    as="dt"
                    color="gray-900"
                    className="font-semibold tracking-tight mb-4"
                  >
                    {faq.question}
                  </Paragraph>
                  <dd>
                    <Paragraph>{faq.answer}</Paragraph>
                  </dd>
                </CardContent>
              </Card>
            ))}
          </dl>
        </CardWrapper>
      </SectionContent>
    </Section>
  );
}
