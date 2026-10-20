import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { nylasFetch } from "@/utils/nylas/client";
import {
  revokeMailboxConnection,
  revokePaidMailboxesForPremium,
} from "./revoke-connection";

vi.mock("@/utils/prisma");

vi.mock("@/utils/nylas/client", () => ({
  nylasFetch: vi.fn(),
  isNylasErrorWithStatus: vi.fn(() => false),
}));

const logger = createTestLogger();

function mockMailbox(account?: {
  id?: string;
  provider?: string;
  transport?: string;
  providerAccountId?: string;
  refresh_token?: string | null;
  disconnectedAt?: Date | null;
}) {
  prisma.emailAccount.findUnique.mockResolvedValue({
    id: "email-account-1",
    account: {
      id: "account-1",
      provider: "google",
      transport: "nylas",
      providerAccountId: "grant-1",
      refresh_token: null,
      disconnectedAt: null,
      ...account,
    },
    // biome-ignore lint/suspicious/noExplicitAny: a partial prisma row is enough
  } as any);
}

describe("revokeMailboxConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.account.update.mockResolvedValue({} as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
    );
  });

  it("deletes the broker grant of a Google mailbox", async () => {
    mockMailbox({ transport: "nylas", providerAccountId: "grant-1" });

    const outcome = await revokeMailboxConnection({
      emailAccountId: "email-account-1",
      logger,
    });

    expect(outcome).toBe("revoked");
    expect(nylasFetch).toHaveBeenCalledWith({
      path: "/grants/grant-1",
      method: "DELETE",
    });
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: expect.objectContaining({ disconnectedAt: expect.any(Date) }),
    });
  });

  it("revokes the refresh token of a Google mailbox reached directly", async () => {
    mockMailbox({
      transport: "oauth",
      providerAccountId: "google-user-id",
      refresh_token: "refresh-token",
    });

    const outcome = await revokeMailboxConnection({
      emailAccountId: "email-account-1",
      logger,
    });

    expect(outcome).toBe("revoked");
    expect(nylasFetch).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: expect.objectContaining({
        refresh_token: null,
        access_token: null,
        disconnectedAt: expect.any(Date),
      }),
    });
  });

  it("leaves a mailbox that is already disconnected alone", async () => {
    mockMailbox({ disconnectedAt: new Date("2026-01-01T00:00:00.000Z") });

    const outcome = await revokeMailboxConnection({
      emailAccountId: "email-account-1",
      logger,
    });

    expect(outcome).toBe("already-gone");
    expect(nylasFetch).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
  });

  it("treats a grant that is already gone as revoked", async () => {
    const { isNylasErrorWithStatus } = await import("@/utils/nylas/client");
    vi.mocked(isNylasErrorWithStatus).mockReturnValue(true);
    mockMailbox();

    const outcome = await revokeMailboxConnection({
      emailAccountId: "email-account-1",
      logger,
    });

    expect(outcome).toBe("revoked");
    expect(prisma.account.update).toHaveBeenCalled();
  });
});

describe("revokePaidMailboxesForPremium", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.account.update.mockResolvedValue({} as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
    );
  });

  it("cuts off the paid mailboxes of the people the subscription covered", async () => {
    prisma.premium.findUnique.mockResolvedValue({
      users: [{ id: "user-1" }],
      admins: [{ id: "user-2" }],
      // biome-ignore lint/suspicious/noExplicitAny: a partial prisma row is enough
    } as any);
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "email-account-1" },
      { id: "email-account-2" },
    ] as never);
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "email-account-1",
      account: {
        id: "account-1",
        provider: "google",
        transport: "nylas",
        providerAccountId: "grant-1",
        refresh_token: null,
        disconnectedAt: null,
      },
      // biome-ignore lint/suspicious/noExplicitAny: a partial prisma row is enough
    } as any);

    const result = await revokePaidMailboxesForPremium({
      customerId: "cus_1",
      logger,
    });

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { in: ["user-1", "user-2"] },
          account: { provider: "google", disconnectedAt: null },
        }),
      }),
    );
    expect(result.revoked).toBe(2);
  });

  it("does nothing when the customer has no subscription on file", async () => {
    prisma.premium.findUnique.mockResolvedValue(null);

    const result = await revokePaidMailboxesForPremium({
      customerId: "cus_1",
      logger,
    });

    expect(result).toEqual({ revoked: 0, skipped: 0 });
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });
});
