import { describe, expect, it } from "vitest";
import { hasTransportCredentials } from "@/utils/email/transport-credentials";

describe("hasTransportCredentials", () => {
  it("accepts a Nylas mailbox with only its grant id", () => {
    // The linking callback stores null tokens on purpose: Nylas holds them. A
    // token check here skipped every message that transport delivered.
    expect(
      hasTransportCredentials({
        transport: "nylas",
        providerAccountId: "grant-1",
        accessToken: null,
        refreshToken: null,
      }),
    ).toBe(true);
  });

  it("rejects a Nylas mailbox with no grant id", () => {
    expect(
      hasTransportCredentials({
        transport: "nylas",
        providerAccountId: null,
      }),
    ).toBe(false);
  });

  it("accepts an IMAP mailbox with an active credential", () => {
    expect(
      hasTransportCredentials({
        transport: "imap",
        accessToken: null,
        refreshToken: null,
        mailboxCredential: { active: true },
      }),
    ).toBe(true);
  });

  it("rejects an IMAP mailbox whose credential was deactivated", () => {
    expect(
      hasTransportCredentials({
        transport: "imap",
        mailboxCredential: { active: false },
      }),
    ).toBe(false);
  });

  it("rejects an IMAP mailbox with no credential row at all", () => {
    expect(
      hasTransportCredentials({ transport: "imap", mailboxCredential: null }),
    ).toBe(false);
  });

  it("still requires both tokens for the OAuth transports", () => {
    // Unchanged for Google and Microsoft: that is what the check was written for.
    expect(
      hasTransportCredentials({
        transport: "oauth",
        accessToken: "a",
        refreshToken: "r",
      }),
    ).toBe(true);
    expect(
      hasTransportCredentials({ transport: "oauth", accessToken: "a" }),
    ).toBe(false);
    expect(
      hasTransportCredentials({ transport: "oauth", refreshToken: "r" }),
    ).toBe(false);
  });
});
