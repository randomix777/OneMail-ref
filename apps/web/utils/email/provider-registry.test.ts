import { describe, expect, it } from "vitest";
import {
  getProviderCapabilities,
  getProviderDefinition,
  getProviderSyncPageSize,
  isMailTransport,
  isProviderFamily,
  MAIL_TRANSPORTS,
  PROVIDER_FAMILIES,
  resolveMailTransport,
  usesPerAccountWatch,
  type ProviderFamily,
} from "@/utils/email/provider-registry";

describe("provider registry", () => {
  const expected = {
    google: {
      // Google mail is reached only through Nylas so we inherit its CASA
      // assessment instead of running our own.
      defaultTransport: "nylas",
      linkingEndpoint: "/api/nylas/linking/auth-url",
      syncPageSize: 50,
      capabilities: { labels: true, starred: true },
    },
    microsoft: {
      defaultTransport: "oauth",
      linkingEndpoint: "/api/outlook/linking/auth-url",
      syncPageSize: 20,
      capabilities: { labels: false, starred: false },
    },
  } satisfies Record<ProviderFamily, unknown>;

  for (const family of PROVIDER_FAMILIES) {
    it(`declares ${family}`, () => {
      const definition = getProviderDefinition(family);
      const declarations = expected[family];

      expect(definition.family).toBe(family);
      expect(definition.defaultTransport).toBe(declarations.defaultTransport);
      expect(definition.linkingEndpoint).toBe(declarations.linkingEndpoint);
      expect(definition.syncPageSize).toBe(declarations.syncPageSize);
      expect(definition.capabilities).toEqual(declarations.capabilities);
    });
  }

  it("names every family for the copy that has to show it", () => {
    for (const family of PROVIDER_FAMILIES) {
      expect(getProviderDefinition(family).label).not.toBe("");
    }
  });

  it("uses a declared transport as every family default", () => {
    for (const family of PROVIDER_FAMILIES) {
      expect(MAIL_TRANSPORTS).toContain(
        getProviderDefinition(family).defaultTransport,
      );
    }
  });

  it("rejects a provider it cannot serve", () => {
    expect(() => getProviderDefinition("carrier-pigeon")).toThrow(
      "Unsupported provider: carrier-pigeon",
    );
  });

  it("does not report an unknown provider as a family", () => {
    expect(isProviderFamily("imap")).toBe(false);
    expect(isProviderFamily("")).toBe(false);
  });

  it("answers capability questions for unvalidated provider values", () => {
    // Copy and feature-gating call sites receive provider strings straight from
    // rows, so an unrecognized value must not throw mid-render. The fallback is
    // the historical Gmail-shaped default; pin it so changing it is deliberate.
    expect(getProviderCapabilities("carrier-pigeon")).toEqual({
      labels: true,
      starred: true,
    });
    expect(getProviderSyncPageSize("carrier-pigeon")).toBe(50);
  });
});

describe("isMailTransport", () => {
  it("accepts every declared transport", () => {
    for (const transport of MAIL_TRANSPORTS) {
      expect(isMailTransport(transport)).toBe(true);
    }
  });

  it("rejects values the account row might hold", () => {
    expect(isMailTransport("google")).toBe(false);
    expect(isMailTransport("")).toBe(false);
    expect(isMailTransport(null)).toBe(false);
    expect(isMailTransport(undefined)).toBe(false);
  });
});

describe("resolveMailTransport", () => {
  it("prefers the stored transport over the family default", () => {
    // A Google mailbox connected through its own client is still legitimate
    // until the direct path is deleted, and it must not be read as Nylas.
    expect(resolveMailTransport("google", "oauth")).toBe("oauth");
    expect(resolveMailTransport("microsoft", "oauth")).toBe("oauth");
  });

  it("falls back to the family default for a missing or unknown value", () => {
    expect(resolveMailTransport("google", null)).toBe("nylas");
    expect(resolveMailTransport("microsoft", undefined)).toBe("oauth");
    expect(resolveMailTransport("google", "carrier-pigeon")).toBe("nylas");
  });

  it("rejects a family it cannot serve rather than guessing a transport", () => {
    // The stored value is used as-is, so a valid one never needs the family. It
    // is only when both are unusable that there is nothing to fall back to.
    expect(resolveMailTransport("carrier-pigeon", "nylas")).toBe("nylas");
    expect(() => resolveMailTransport("carrier-pigeon", null)).toThrow(
      "Unsupported provider: carrier-pigeon",
    );
  });
});

describe("usesPerAccountWatch", () => {
  it("only asks for a subscription on transports that hold one", () => {
    expect(usesPerAccountWatch("oauth")).toBe(true);
    // Nylas pushes every grant to one application-level webhook.
    expect(usesPerAccountWatch("nylas")).toBe(false);
    // IMAP has no push at all; our own poll covers it.
    expect(usesPerAccountWatch("imap")).toBe(false);
  });
});
