import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import { SectionHeading } from "@/components/new-landing/common/Typography";
import { BlurFade } from "@/components/new-landing/common/BlurFade";

/**
 * The three things that make it a client.
 *
 * A product page earns its length with the interface and one idea per block,
 * so these are the claims the code can back up, in the order a reader meets
 * them.
 */
const CAPABILITIES = [
  {
    title: "Every mailbox, one window",
    description:
      "Gmail, Outlook, Yahoo, Fastmail, iCloud, Zoho or any IMAP server. Read them side by side and search across all of them.",
  },
  {
    title: "Your mail, indexed locally",
    description:
      "A local database keeps a copy of every mailbox with a full-text index over it, so the list opens from that index instead of a round trip.",
  },
  {
    title: "Keys for everything",
    description:
      "Archive, star, snooze, reply, undo. Every action has a key, and every action can be taken back.",
  },
];

export function ClientCapabilities() {
  return (
    <Section>
      <SectionHeading>Three things that matter</SectionHeading>
      <SectionContent
        noMarginTop
        className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3 md:gap-6"
      >
        {CAPABILITIES.map((capability, index) => (
          <BlurFade key={capability.title} delay={0.1 * index} inView>
            <div className="text-left">
              <p className="font-mono text-xs text-gray-400">0{index + 1}</p>
              <h3 className="mt-3 font-title text-xl leading-7 text-[#242424]">
                {capability.title}
              </h3>
              <p className="mt-3 text-sm leading-6 text-gray-500">
                {capability.description}
              </p>
            </div>
          </BlurFade>
        ))}
      </SectionContent>
    </Section>
  );
}
