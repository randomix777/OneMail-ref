import Link from "next/link";
import { Button } from "@/components/new-landing/common/Button";
import { Paragraph } from "@/components/new-landing/common/Typography";
import { BRAND_NAME } from "@/utils/branding";

/**
 * The one thing to do next.
 *
 * A product page ends with a single action, so this is a single button and
 * the two facts that decide whether someone clicks it: it is free, and it runs
 * on their own machine.
 */
export function GetStartedBand() {
  return (
    <div className="mx-auto max-w-[720px] px-6 py-20 text-center md:py-28">
      <h2 className="font-title text-[1.7rem] leading-tight text-[#242424] md:text-[2.5rem]">
        One client. Every mailbox. Yours to run.
      </h2>
      <Paragraph size="lg" className="mx-auto mt-4 max-w-[560px]">
        {BRAND_NAME} is open source and the client is free. Run it on your own
        infrastructure, and you only pay for what actually costs money: Google
        mailboxes, and the tokens the assistant uses.
      </Paragraph>
      <div className="mt-8 flex flex-col items-center gap-3">
        <Button size="xl" asChild>
          <Link href="/login">
            <span className="relative z-10">Get started</span>
          </Link>
        </Button>
        <Paragraph size="sm" color="light">
          Free to run · macOS, Windows and the web
        </Paragraph>
      </div>
    </div>
  );
}
