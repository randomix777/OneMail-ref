import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { pollImapMailbox } from "@/utils/imap/poll";
import { hasCronSecret } from "@/utils/cron";
import { GET } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/imap/poll");
vi.mock("@/utils/cron");
vi.mock("@/utils/error", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/error")>()),
  captureException: vi.fn(),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  with: vi.fn(() => logger),
} as never;

function request() {
  return new NextRequest("http://localhost:3000/api/cron/imap-poll");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasCronSecret).mockReturnValue(true);
  prisma.emailAccount.findMany.mockResolvedValue([
    { id: "acc-1", email: "one@example.com" },
    { id: "acc-2", email: "two@example.com" },
  ] as never);
  prisma.emailAccount.update.mockResolvedValue(undefined as never);
  vi.mocked(pollImapMailbox).mockResolvedValue({
    status: "processed",
    processed: 3,
  });
});

describe("imap poll cron", () => {
  it("refuses a request without the cron secret", async () => {
    vi.mocked(hasCronSecret).mockReturnValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });

  it("polls each mailbox in the batch and sums what it processed", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(body).toEqual({
      accounts: 2,
      processed: 6,
      skipped: 0,
      failed: [],
    });
    expect(pollImapMailbox).toHaveBeenCalledTimes(2);
  });

  it("counts a skipped mailbox without treating it as a failure", async () => {
    vi.mocked(pollImapMailbox).mockResolvedValueOnce({
      status: "skipped",
      processed: 0,
    });

    const body = await (await GET(request())).json();

    expect(body).toMatchObject({ processed: 3, skipped: 1, failed: [] });
  });

  it("keeps going when one mailbox fails", async () => {
    // One unreachable server must not stop the rest of the batch.
    vi.mocked(pollImapMailbox).mockRejectedValueOnce(new Error("imap down"));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ processed: 3, failed: ["acc-1"] });
    expect(pollImapMailbox).toHaveBeenCalledTimes(2);
  });

  it("records an attempt for every mailbox, including skipped and failed ones", async () => {
    // This timestamp is what moves a mailbox to the back of the queue; without it
    // the same skipped accounts fill every batch and the rest are never polled.
    vi.mocked(pollImapMailbox)
      .mockResolvedValueOnce({ status: "skipped", processed: 0 })
      .mockRejectedValueOnce(new Error("imap down"));

    await GET(request());

    expect(prisma.emailAccount.update).toHaveBeenCalledTimes(2);
    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      data: { imapLastPolledAt: expect.any(Date) },
    });
    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-2" },
      data: { imapLastPolledAt: expect.any(Date) },
    });
  });

  it("orders the batch by the last attempt, oldest first", async () => {
    await GET(request());

    // Ordering by updatedAt would keep skipped mailboxes (which write nothing) at
    // the front forever.
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { imapLastPolledAt: { sort: "asc", nulls: "first" } },
      }),
    );
  });

  it("only looks at connected IMAP mailboxes", async () => {
    await GET(request());

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { account: { transport: "imap", disconnectedAt: null } },
      }),
    );
  });
});
