import { describe, expect, it } from "vitest";
import { resolveConnection } from "@/utils/actions/mailbox-credentials.helpers";

const base = {
  provider: "zoho",
  email: "ada@zoho.com",
  secret: "app-password",
};

describe("resolveConnection", () => {
  it("fills a preset family from its preset", () => {
    expect(resolveConnection({ input: base, family: "zoho" })).toMatchObject({
      imapHost: "imap.zoho.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.zoho.com",
      smtpPort: 465,
      smtpSecure: true,
      username: "ada@zoho.com",
    });
  });

  it("keeps the TLS mode the preset documents, even against a secure default", () => {
    // iCloud SMTP is 587 with STARTTLS. A form that defaulted the flag to true
    // would try implicit TLS on that port and fail every send, so the preset has
    // to win over the input.
    const connection = resolveConnection({
      input: { ...base, provider: "icloud", smtpSecure: true },
      family: "icloud",
    });

    expect(connection.smtpPort).toBe(587);
    expect(connection.smtpSecure).toBe(false);
  });

  it("uses the hostnames a generic server is given", () => {
    const connection = resolveConnection({
      input: {
        ...base,
        provider: "imap",
        imapHost: "mail.example.com",
        imapPort: 993,
        smtpHost: "mail.example.com",
        smtpPort: 587,
        smtpSecure: false,
      },
      family: "imap",
    });

    expect(connection).toMatchObject({
      imapHost: "mail.example.com",
      imapPort: 993,
      smtpHost: "mail.example.com",
      smtpPort: 587,
      smtpSecure: false,
    });
  });

  it("refuses a generic server with no hostnames", () => {
    expect(() =>
      resolveConnection({
        input: { ...base, provider: "imap" },
        family: "imap",
      }),
    ).toThrow(/IMAP and SMTP details/);
  });

  it("lets a user override a preset host", () => {
    // Zoho's paid domain accounts live on imappro/smtppro rather than the
    // personal hosts.
    const connection = resolveConnection({
      input: { ...base, imapHost: "imappro.zoho.com" },
      family: "zoho",
    });

    expect(connection.imapHost).toBe("imappro.zoho.com");
    expect(connection.imapPort).toBe(993);
  });
});
