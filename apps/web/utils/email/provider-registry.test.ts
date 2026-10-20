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
      connection: { kind: "redirect", endpoint: "/api/nylas/linking/auth-url" },
      syncPageSize: 50,
      capabilities: {
        labels: true,
        starred: true,
        bulkActions: true,
        viewerReplies: true,
      },
    },
    microsoft: {
      defaultTransport: "oauth",
      connection: {
        kind: "redirect",
        endpoint: "/api/outlook/linking/auth-url",
      },
      syncPageSize: 20,
      capabilities: {
        labels: false,
        starred: false,
        bulkActions: true,
        viewerReplies: true,
      },
    },
    // Reachable only by submitting an app password: none of these can connect a
    // third-party client through a redirect we could send the user to.
    yahoo: {
      defaultTransport: "imap",
      connection: { kind: "credentials" },
      syncPageSize: 50,
      capabilities: {
        labels: false,
        starred: true,
        bulkActions: false,
        viewerReplies: true,
      },
    },
    zoho: {
      defaultTransport: "imap",
      connection: { kind: "credentials" },
      syncPageSize: 50,
      capabilities: {
        labels: false,
        starred: true,
        bulkActions: false,
        viewerReplies: true,
      },
    },
    fastmail: {
      defaultTransport: "imap",
      connection: { kind: "credentials" },
      syncPageSize: 50,
      // Fastmail's labels are real IMAP folders a message can appear in several
      // of, so it reads as labels rather than a single-folder model.
      capabilities: {
        labels: true,
        starred: true,
        bulkActions: false,
        viewerReplies: true,
      },
    },
    icloud: {
      defaultTransport: "imap",
      connection: { kind: "credentials" },
      syncPageSize: 50,
      capabilities: {
        labels: false,
        starred: true,
        bulkActions: false,
        viewerReplies: true,
      },
    },
    imap: {
      defaultTransport: "imap",
      connection: { kind: "credentials" },
      syncPageSize: 50,
      capabilities: {
        labels: false,
        starred: true,
        bulkActions: false,
        viewerReplies: true,
      },
    },
  } satisfies Record<ProviderFamily, unknown>;

  for (const family of PROVIDER_FAMILIES) {
    it(`declares ${family}`, () => {
      const definition = getProviderDefinition(family);
      const declarations = expected[family];

      expect(definition.family).toBe(family);
      expect(definition.defaultTransport).toBe(declarations.defaultTransport);
      expect(definition.connection).toEqual(declarations.connection);
      expect(definition.syncPageSize).toBe(declarations.syncPageSize);
      expect(definition.capabilities).toEqual(declarations.capabilities);
    });
  }

  it("only offers a redirect for a family reached over OAuth", () => {
    for (const family of PROVIDER_FAMILIES) {
      const { connection, defaultTransport } = getProviderDefinition(family);

      // A credentials family reached over `oauth` would have no redirect to
      // start and no credential form either, leaving it connectable by neither.
      if (connection.kind === "credentials") {
        expect(defaultTransport).toBe("imap");
      } else {
        expect(connection.endpoint.startsWith("/api/")).toBe(true);
      }
    }
  });

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
    // Not "imap": that is a family of its own now, which is the point of the
    // transport/family split rather than an implementation detail.
    expect(isProviderFamily("carrier-pigeon")).toBe(false);
    expect(isProviderFamily("")).toBe(false);
  });

  it("answers capability questions for unvalidated provider values", () => {
    // Copy and feature-gating call sites receive provider strings straight from
    // rows, so an unrecognized value must not throw mid-render. The fallback is
    // the historical Gmail-shaped default; pin it so changing it is deliberate.
    expect(getProviderCapabilities("carrier-pigeon")).toEqual({
      labels: true,
      starred: true,
      bulkActions: true,
      viewerReplies: true,
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
