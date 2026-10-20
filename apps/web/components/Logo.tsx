import Image from "next/image";
import { cn } from "@/utils";
import { BRAND_LOGO_URL, BRAND_NAME } from "@/utils/branding";

interface LogoProps {
  className?: string;
}

export function Logo({ className }: LogoProps) {
  if (BRAND_LOGO_URL) {
    return (
      <Image
        src={BRAND_LOGO_URL}
        alt={`${BRAND_NAME} logo`}
        width={209}
        height={25}
        className={className}
        unoptimized
      />
    );
  }

  return (
    <span
      className={cn(
        "font-title text-xl leading-none font-semibold tracking-tight",
        className,
      )}
    >
      {BRAND_NAME}
    </span>
  );
}
