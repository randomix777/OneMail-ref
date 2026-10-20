import type { ComponentProps } from "react";
import Link from "next/link";
import { env } from "@/env";
import { BRAND_LEGAL_NAME, BRAND_NAME } from "@/utils/branding";
import { CookieSettingsButton } from "@/components/CookieConsent";

export const footerNavigation = {
  main: [
    { name: "Mail client", href: "/" },
    { name: "Desktop app", href: "/app" },
    { name: "Pricing", href: "/pricing" },
    { name: "Open source", href: "/github", target: "_blank" },
  ],
  support: [
    {
      name: "Documentation",
      href: "https://docs.jyisolutions.com",
      target: "_blank",
    },
    { name: "Contact us", href: `mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}` },
    { name: "Changelog", href: "/changelog", target: "_blank" },
  ],
  company: [
    { name: "GitHub", href: "/github", target: "_blank" },
    { name: "Discord", href: "/discord", target: "_blank" },
    { name: "OSS Friends", href: "/oss-friends" },
  ],
  legal: [
    {
      name: "Terms",
      href: "https://www.jyisolutions.com/terms",
      target: "_blank",
    },
    {
      name: "Privacy",
      href: "https://www.jyisolutions.com/privacy",
      target: "_blank",
    },
  ],
  social: [
    {
      name: "GitHub",
      href: "/github",
      target: "_blank",
      icon: (props: ComponentProps<"svg">) => (
        <svg fill="currentColor" viewBox="0 0 24 24" {...props}>
          <title>GitHub</title>
          <path
            fillRule="evenodd"
            d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
            clipRule="evenodd"
          />
        </svg>
      ),
    },
    {
      name: "Discord",
      href: "/discord",
      target: "_blank",
      icon: (props: ComponentProps<"svg">) => (
        <svg fill="currentColor" viewBox="0 0 48 48" {...props}>
          <title>Discord</title>
          <path d="M40,12c0,0-4.585-3.588-10-4l-0.488,0.976C34.408,10.174,36.654,11.891,39,14c-4.045-2.065-8.039-4-15-4s-10.955,1.935-15,4c2.346-2.109,5.018-4.015,9.488-5.024L18,8c-5.681,0.537-10,4-10,4s-5.121,7.425-6,22c5.162,5.953,13,6,13,6l1.639-2.185C13.857,36.848,10.715,35.121,8,32c3.238,2.45,8.125,5,16,5s12.762-2.55,16-5c-2.715,3.121-5.857,4.848-8.639,5.815L33,40c0,0,7.838-0.047,13-6C45.121,19.425,40,12,40,12z M17.5,30c-1.933,0-3.5-1.791-3.5-4c0-2.209,1.567-4,3.5-4s3.5,1.791,3.5,4C21,28.209,19.433,30,17.5,30z M30.5,30c-1.933,0-3.5-1.791-3.5-4c0-2.209,1.567-4,3.5-4s3.5,1.791,3.5,4C34,28.209,32.433,30,30.5,30z" />
        </svg>
      ),
    },
  ],
};

// Simple footer for self-hosted deployments
const selfHostedFooter = {
  resources: [
    {
      name: "Documentation",
      href: "https://docs.jyisolutions.com",
      target: "_blank",
    },
    { name: "Contact us", href: `mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}` },
    { name: "GitHub", href: "/github", target: "_blank" },
    { name: "Discord", href: "/discord", target: "_blank" },
  ],
  legal: [
    {
      name: "Terms",
      href: "https://www.jyisolutions.com/terms",
      target: "_blank",
    },
    {
      name: "Privacy",
      href: "https://www.jyisolutions.com/privacy",
      target: "_blank",
    },
  ],
};

export function Footer() {
  const copyrightName = BRAND_LEGAL_NAME;

  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return (
      <footer className="relative">
        <div className="mx-auto max-w-7xl overflow-hidden px-6 py-12 lg:px-8">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {selfHostedFooter.resources.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                target={item.target}
                rel={
                  item.target === "_blank" ? "noopener noreferrer" : undefined
                }
                className="text-sm leading-6 text-gray-600 hover:text-gray-900"
              >
                {item.name}
              </Link>
            ))}
            <span className="text-gray-300">|</span>
            {selfHostedFooter.legal.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                className="text-sm leading-6 text-gray-600 hover:text-gray-900"
              >
                {item.name}
              </Link>
            ))}
            <CookieSettingsButton className="text-sm leading-6 text-gray-600 hover:text-gray-900" />
          </div>
          <p className="mt-6 text-center text-xs leading-5 text-gray-500">
            Powered by{" "}
            <Link
              href={env.NEXT_PUBLIC_BASE_URL}
              className="hover:text-gray-900"
            >
              {BRAND_NAME}
            </Link>
          </p>
        </div>
      </footer>
    );
  }

  return (
    <footer className="relative">
      <div className="mx-auto max-w-7xl overflow-hidden px-6 py-20 sm:py-24 lg:px-8">
        <nav aria-label="Footer">
          <div className="mt-16 grid grid-cols-2 gap-8 lg:grid-cols-4 xl:mt-0">
            <div>
              <FooterList title="Product" items={footerNavigation.main} />
            </div>
            <div>
              <FooterList title="Support" items={footerNavigation.support} />
            </div>
            <div>
              <FooterList title="Company" items={footerNavigation.company} />
            </div>
            <div>
              <FooterList title="Legal" items={footerNavigation.legal} />
              <CookieSettingsButton className="mt-4 text-sm leading-6 text-gray-600 hover:text-gray-900" />
            </div>
          </div>
        </nav>

        <div className="mt-16 flex justify-center space-x-10">
          {footerNavigation.social.map((item) => (
            <Link
              key={item.name}
              href={item.href}
              className="text-gray-400 hover:text-gray-500"
            >
              <span className="sr-only">{item.name}</span>
              <item.icon className="h-6 w-6" aria-hidden="true" />
            </Link>
          ))}
        </div>
        <p className="mt-10 text-center text-xs leading-5 text-gray-500">
          &copy; {new Date().getFullYear()} {copyrightName}. All rights
          reserved.
        </p>
      </div>
    </footer>
  );
}

function FooterList(props: {
  title: string;
  items: { name: string; href: string; target?: string }[];
}) {
  return (
    <>
      <h3 className="text-sm font-semibold leading-6 text-gray-900">
        {props.title}
      </h3>
      <ul className="mt-6 space-y-4">
        {props.items.map((item) => (
          <li key={item.name}>
            <Link
              href={item.href}
              target={item.target}
              prefetch={false}
              className="text-sm leading-6 text-gray-600 hover:text-gray-900"
            >
              {item.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
