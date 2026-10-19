import { describe, expect, it } from "vitest";
import { connectImapMailboxBody } from "@/utils/actions/mailbox-credentials.validation";
import { getImapPreset, IMAP_PRESETS } from "@/utils/imap/presets";

describe("IMAP presets", () => {
  it("declares the endpoints each provider documents", () => {
    expect(getImapPreset("zoho")).toMatchObject({
      imapHost: "imap.zoho.com",
      imapPort: 993,
      smtpHost: "smtp.zoho.com",
      smtpPort: 465,
    });
    expect(getImapPreset("fastmail")).toMatchObject({
      imapHost: "imap.fastmail.com",
      imapPort: 993,
      smtpHost: "smtp.fastmail.com",
      smtpPort: 465,
    });
    expect(getImapPreset("yahoo")).toMatchObject({
      imapHost: "imap.mail.yahoo.com",
      imapPort: 993,
      smtpHost: "smtp.mail.yahoo.com",
    });
    expect(getImapPreset("icloud")).toMatchObject({
      imapHost: "imap.mail.me.com",
      imapPort: 993,
      smtpHost: "smtp.mail.me.com",
      // Apple documents STARTTLS on 587, not implicit TLS.
      smtpPort: 587,
      smtpSecure: false,
    });
  });

  it("has no preset for a generic IMAP server", () => {
    // Nothing to guess: the form has to ask for the hostnames.
    expect(getImapPreset("imap")).toBeNull();
  });

  it("uses implicit TLS for every IMAP endpoint it presets", () => {
    for (const preset of Object.values(IMAP_PRESETS)) {
      expect(preset.imapSecure).toBe(true);
      expect(preset.imapPort).toBe(993);
    }
  });

  it("tells the user which password form to use", () => {
    // These differ per provider and getting them wrong is the most likely
    // failure, so every preset has to say.
    for (const preset of Object.values(IMAP_PRESETS)) {
      expect(preset.passwordHint.length).toBeGreaterThan(20);
    }
  });
});

describe("connectImapMailboxBody", () => {
  const base = {
    provider: "zoho",
    email: "ada@zoho.com",
    secret: "app-password",
  };

  it("accepts a preset family without hostnames", () => {
    expect(connectImapMailboxBody.safeParse(base).success).toBe(true);
  });

  it("requires hostnames for a generic IMAP server", () => {
    const result = connectImapMailboxBody.safeParse({
      ...base,
      provider: "imap",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["imapHost"]);
    }
  });

  it("accepts a generic server once the hostnames are given", () => {
    const result = connectImapMailboxBody.safeParse({
      ...base,
      provider: "imap",
      imapHost: "mail.example.com",
      imapPort: 993,
      smtpHost: "mail.example.com",
      smtpPort: 587,
    });

    expect(result.success).toBe(true);
  });

  it("refuses a provider that is not reached over IMAP", () => {
    // Google goes through Nylas and Microsoft through Graph; neither belongs in
    // a password form.
    expect(
      connectImapMailboxBody.safeParse({ ...base, provider: "google" }).success,
    ).toBe(false);
  });

  it("refuses an invalid port", () => {
    expect(
      connectImapMailboxBody.safeParse({
        ...base,
        provider: "imap",
        imapHost: "mail.example.com",
        imapPort: 0,
        smtpHost: "mail.example.com",
        smtpPort: 465,
      }).success,
    ).toBe(false);
  });

  it("requires a secret and an address", () => {
    expect(
      connectImapMailboxBody.safeParse({ ...base, secret: "" }).success,
    ).toBe(false);
    expect(
      connectImapMailboxBody.safeParse({ ...base, email: "not-an-address" })
        .success,
    ).toBe(false);
  });
});
