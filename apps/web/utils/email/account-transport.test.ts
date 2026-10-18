import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMailboxTransportContext } from "@/utils/email/account-transport";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

describe("getMailboxTransportContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(null);
  });

  it("returns the transport and grant id recorded on the account", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { transport: "nylas", providerAccountId: "grant-1" },
    } as never);

    await expect(
      getMailboxTransportContext({
        emailAccountId: "email-account-1",
        provider: "google",
      }),
    ).resolves.toEqual({ transport: "nylas", providerAccountId: "grant-1" });
  });

  it("falls back to the family default when no account row is found", async () => {
    await expect(
      getMailboxTransportContext({
        emailAccountId: "email-account-1",
        provider: "microsoft",
      }),
    ).resolves.toEqual({ transport: "oauth", providerAccountId: null });
  });

  it("falls back to the family default for an unrecognized stored value", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { transport: "smoke-signal", providerAccountId: "x" },
    } as never);

    await expect(
      getMailboxTransportContext({
        emailAccountId: "email-account-1",
        provider: "google",
      }),
    ).resolves.toEqual({ transport: "nylas", providerAccountId: "x" });
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
