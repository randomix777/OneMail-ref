import Image from "next/image";
import {
  Section,
  SectionContent,
} from "@/components/new-landing/common/Section";
import {
  PageHeading,
  Paragraph,
} from "@/components/new-landing/common/Typography";
import { CallToAction } from "@/components/new-landing/CallToAction";
import { HeroReveal } from "@/components/new-landing/common/HeroReveal";
import { UnicornScene } from "@/components/new-landing/UnicornScene";
import {
  Badge,
  type BadgeVariant,
} from "@/components/new-landing/common/Badge";
import { HeroVideoDialog } from "@/app/(landing)/home/HeroVideoDialog";
import { ClientPreview } from "@/components/new-landing/ClientPreview";
import { MailboxMark } from "@/components/new-landing/MailboxMark";
import { MAILBOXES } from "@/components/new-landing/mailboxes";

interface HeroProps {
  badge?: React.ReactNode;
  badgeVariant?: BadgeVariant;
  children?: React.ReactNode;
  cta?: React.ReactNode;
  /** The one quiet fact under the call to action. */
  ctaNote?: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  title?: React.ReactNode;
}

export function Hero({
  title,
  subtitle,
  badge,
  badgeVariant = "blue",
  children,
  cta,
  ctaNote,
  icon,
}: HeroProps) {
  return (
    <Section className="relative mt-7 md:mt-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[420px] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(0,110,255,0.12),transparent_70%)]"
      />
      {icon ? (
        <HeroReveal className="mb-7 flex justify-center">{icon}</HeroReveal>
      ) : null}
      {badge ? (
        <HeroReveal className="mb-7 flex justify-center">
          <Badge variant={badgeVariant}>{badge}</Badge>
        </HeroReveal>
      ) : null}
      <PageHeading>{title}</PageHeading>
      <HeroReveal delay={0.125 * 5}>
        <Paragraph size="lg" className="mx-auto mt-6 max-w-[640px]">
          {subtitle}
        </Paragraph>
      </HeroReveal>
      <SectionContent noMarginTop className="mt-8 md:mt-10">
        <div className="mb-10 space-y-6">
          <HeroReveal delay={0.125 * 7}>
            <div className="flex flex-col items-center gap-3">
              {cta ?? <CallToAction />}
              {ctaNote ? (
                <Paragraph size="sm" color="light">
                  {ctaNote}
                </Paragraph>
              ) : null}
            </div>
          </HeroReveal>
          <HeroReveal delay={0.125 * 8}>
            <MailboxRow />
          </HeroReveal>
        </div>
        {children}
      </SectionContent>
    </Section>
  );
}

/**
 * The mailboxes the client can read.
 *
 * The same list the app accepts, so the page cannot promise a provider the
 * client does not support.
 */
export function MailboxRow() {
  return (
    <div className="flex flex-col items-center gap-3 md:flex-row md:justify-center md:gap-4">
      <Paragraph color="light" size="sm" className="shrink-0">
        Reads
      </Paragraph>
      <ul className="flex flex-wrap items-center justify-center gap-2">
        {MAILBOXES.map((mailbox) => (
          <li
            key={mailbox.family}
            className="flex items-center gap-1.5 rounded-full border border-[#E7E7E7] bg-white py-1 pr-3 pl-1 shadow-[0px_1px_2px_0px_#97979714]"
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
  );
}

/**
 * The client, on screen.
 *
 * A picture of the interface is the fastest way to say what the product is,
 * so the hero shows the window rather than a promise about it.
 */
export function ClientShowcase({ className }: { className?: string }) {
  return (
    <HeroReveal delay={0.125 * 9} className={className}>
      <ClientPreview />
    </HeroReveal>
  );
}

export function HeroVideoPlayer({
  video,
}: {
  video?: { muxPlaybackId: string; thumbnailTime?: number; title: string };
}) {
  const muxThumbnail = video?.thumbnailTime !== undefined;

  return (
    <HeroReveal className="relative w-full" delay={0.125 * 9}>
      <div className="relative block overflow-hidden rounded-3xl border border-[#EFEFEF] md:rounded-[43px]">
        <HeroVideoDialog
          playbackId={video?.muxPlaybackId}
          thumbnailTime={video?.thumbnailTime}
          title={video?.title}
        />
        <Image
          src={
            muxThumbnail
              ? `https://image.mux.com/${video.muxPlaybackId}/thumbnail.jpg?time=${video.thumbnailTime}&width=2560`
              : "/images/new-landing/video-thumbnail.webp"
          }
          alt={video?.title ?? "an organized inbox"}
          width={2560}
          height={muxThumbnail ? 1440 : 1404}
          sizes="(min-width: 1280px) 1152px, (min-width: 1024px) calc(100vw - 64px), calc(100vw - 48px)"
          preload
          className="h-auto w-full"
        />
        <UnicornScene className="h-[calc(100%+5px)] opacity-30" />
      </div>
    </HeroReveal>
  );
}

export function HeroContent() {
  return <HeroVideoPlayer />;
}
