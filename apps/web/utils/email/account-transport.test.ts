import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMailboxTransportContext } from "@/utils/email/account-transport";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

const CREDENTIAL = {
  provider: "zoho",
  active: true,
  imapHost: "imap.zoho.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.zoho.com",
  smtpPort: 465,
  smtpSecure: true,
  username: "ada@zoho.com",
  secret: "app-password",
};

describe("getMailboxTransportContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(null);
  });

  it("returns the transport and grant id recorded on the account", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "ada@example.com",
      account: { transport: "nylas", providerAccountId: "grant-1" },
      mailboxCredential: null,
    } as never);

    await expect(
      getMailboxTransportContext({
        emailAccountId: "email-account-1",
        provider: "google",
      }),
    ).resolves.toEqual({
      transport: "nylas",
      email: "ada@example.com",
      providerAccountId: "grant-1",
      credential: null,
    });
  });

  it("returns the credentials for an IMAP mailbox", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "ada@zoho.com",
      account: { transport: "imap", providerAccountId: null },
      mailboxCredential: CREDENTIAL,
    } as never);

    await expect(
      getMailboxTransportContext({
        emailAccountId: "email-account-1",
        provider: "zoho",
      }),
    ).resolves.toEqual({
      transport: "imap",
      email: "ada@zoho.com",
      providerAccountId: null,
      credential: CREDENTIAL,
    });
  });

  it("withholds the credentials for a mailbox that does not use them", async () => {
    // An OAuth mailbox must not carry an app password around in memory.
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "ada@example.com",
      account: { transport: "oauth", providerAccountId: null },
      mailboxCredential: CREDENTIAL,
    } as never);

    const context = await getMailboxTransportContext({
      emailAccountId: "email-account-1",
      provider: "microsoft",
    });

    expect(context.credential).toBeNull();
  });

  it("reads the mailbox address in the same query", async () => {
    await getMailboxTransportContext({
      emailAccountId: "email-account-1",
      provider: "microsoft",
    });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ email: true }),
      }),
    );
  });

  it("falls back to the family default when no account row is found", async () => {
    await expect(
      getMailboxTransportContext({
        emailAccountId: "email-account-1",
        provider: "microsoft",
      }),
    ).resolves.toEqual({
      transport: "oauth",
      email: null,
      providerAccountId: null,
      credential: null,
    });
  });

  it("falls back to the family default for an unrecognized stored value", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "ada@example.com",
      account: { transport: "smoke-signal", providerAccountId: "x" },
      mailboxCredential: null,
    } as never);

    await expect(
      getMailboxTransportContext({
        emailAccountId: "email-account-1",
        provider: "google",
      }),
    ).resolves.toEqual({
      transport: "nylas",
      email: "ada@example.com",
      providerAccountId: "x",
      credential: null,
    });
  });

  it("rejects a provider it cannot serve", async () => {
    await expect(
      getMailboxTransportContext({
        emailAccountId: "email-account-1",
        provider: "carrier-pigeon",
      }),
    ).rejects.toThrow("Unsupported provider: carrier-pigeon");
  });
});
