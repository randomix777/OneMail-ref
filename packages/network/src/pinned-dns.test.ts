import { afterEach, describe, expect, it, vi } from "vitest";
import { lookup, resolve4, resolve6 } from "node:dns/promises";
import { resolveHostAddresses } from "./pinned-dns";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

describe("Workers DNS resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses DNS records when the runtime does not support OS lookup", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.mocked(resolve4).mockResolvedValue(["203.0.113.5"]);
    vi.mocked(resolve6).mockRejectedValue(new Error("no AAAA record"));
    expect(await resolveHostAddresses("mail.example.com")).toEqual([
      { address: "203.0.113.5", family: 4 },
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("fails closed when neither record type can be resolved", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.mocked(resolve4).mockRejectedValue(new Error("DNS failed"));
    vi.mocked(resolve6).mockRejectedValue(new Error("DNS failed"));
    await expect(
      resolveHostAddresses("mail.example.com"),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});
