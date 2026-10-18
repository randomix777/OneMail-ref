import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canUseDriveFiling,
  isDriveFilingAvailable,
} from "@/utils/drive/availability";

const prisma = vi.hoisted(() => ({
  emailAccount: { findUnique: vi.fn() },
}));

vi.mock("@/utils/prisma", () => ({ default: prisma }));

describe("canUseDriveFiling", () => {
  it("disables Google Drive for a mailbox carried by Nylas", () => {
    // Nylas brokers mail, calendar and contacts but not Drive, so filing would
    // mean our own client asking for the Drive scope again.
    expect(canUseDriveFiling({ provider: "google", transport: "nylas" })).toBe(
      false,
    );
  });

  it("keeps Google Drive for the direct Google client", () => {
    expect(canUseDriveFiling({ provider: "google", transport: "oauth" })).toBe(
      true,
    );
  });

  it("leaves OneDrive alone, because Microsoft mail is not on Nylas", () => {
    expect(
      canUseDriveFiling({ provider: "microsoft", transport: "oauth" }),
    ).toBe(true);
    expect(
      canUseDriveFiling({ provider: "microsoft", transport: "nylas" }),
    ).toBe(true);
  });

  it("refuses a provider it does not know how to file to", () => {
    expect(canUseDriveFiling({ provider: "imap", transport: "imap" })).toBe(
      false,
    );
  });
});

describe("isDriveFilingAvailable", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads the mailbox's own account", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google", transport: "nylas" },
    });

    await expect(isDriveFilingAvailable("email-account-1")).resolves.toBe(
      false,
    );
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "email-account-1" },
      select: { account: { select: { provider: true, transport: true } } },
    });
  });

  it("allows the direct Google transport", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google", transport: "oauth" },
    });

    await expect(isDriveFilingAvailable("email-account-1")).resolves.toBe(true);
  });

  it("treats a missing mailbox as unavailable", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    await expect(isDriveFilingAvailable("email-account-1")).resolves.toBe(
      false,
    );
  });
});
