import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasNylasConfig,
  isNylasErrorWithStatus,
  NylasApiError,
  nylasFetch,
} from "@/utils/nylas/client";
import { sleep } from "@/utils/sleep";

const { nylasEnv } = vi.hoisted(() => ({
  nylasEnv: {
    NYLAS_API_KEY: "nylas-api-key" as string | undefined,
    NYLAS_CLIENT_ID: "nylas-client-id" as string | undefined,
    NYLAS_API_URI: "https://api.us.nylas.com",
  },
}));

vi.mock("@/env", () => ({ env: nylasEnv }));
vi.mock("@/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const fetchMock = vi.fn();

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

describe("nylasFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    nylasEnv.NYLAS_CLIENT_ID = "nylas-client-id";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("calls the v3 API of the configured region", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await nylasFetch({ path: "/grants/grant-1/messages" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.us.nylas.com/v3/grants/grant-1/messages",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("omits absent query parameters instead of sending empty values", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await nylasFetch({
      path: "/grants/grant-1/messages",
      query: { limit: 10, unread: true, page_token: undefined, search: null },
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("limit=10");
    expect(url).toContain("unread=true");
    expect(url).not.toContain("page_token");
    expect(url).not.toContain("search");
  });

  it("authenticates with the application API key", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await nylasFetch({ path: "/grants" });

    const init = fetchMock.mock.calls[0][1] as { headers: HeadersInit };
    expect(init.headers).toMatchObject({
      Authorization: "Bearer nylas-api-key",
    });
  });

  it("returns the parsed response body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: "msg-1" } }));

    await expect(
      nylasFetch<{ data: { id: string } }>({
        path: "/grants/g/messages/msg-1",
      }),
    ).resolves.toEqual({ data: { id: "msg-1" } });
  });

  it("returns nothing for an empty 204 response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      nylasFetch({ path: "/grants/g", method: "DELETE" }),
    ).resolves.toBeUndefined();
  });

  it("waits the Retry-After the API asks for before retrying a throttle", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "Too many requests" } },
          { status: 429, headers: { "Retry-After": "2" } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    await expect(nylasFetch({ path: "/grants/g/messages" })).resolves.toEqual({
      data: [],
    });

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a server error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Bad gateway" } }, { status: 502 }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    await expect(nylasFetch({ path: "/grants/g/messages" })).resolves.toEqual({
      data: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected request", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: { message: "Invalid query", type: "invalid_request" },
          request_id: "req_123",
        },
        { status: 400 },
      ),
    );

    await expect(nylasFetch({ path: "/grants/g/messages" })).rejects.toThrow(
      "Nylas request failed with status 400: Invalid query: request_id req_123",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the attempt budget and surfaces the last failure", async () => {
    // A Response body can only be read once, so every attempt needs its own.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ error: { message: "Unavailable" } }, { status: 503 }),
      ),
    );

    await expect(nylasFetch({ path: "/grants/g/messages" })).rejects.toThrow(
      "Unavailable",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses to call the API without an API key", async () => {
    nylasEnv.NYLAS_API_KEY = undefined;

    await expect(nylasFetch({ path: "/grants" })).rejects.toThrow(
      "NYLAS_API_KEY is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isNylasErrorWithStatus", () => {
  it("identifies an error by status without exposing the error shape", () => {
    const notFound = new NylasApiError({ status: 404, message: "missing" });

    expect(isNylasErrorWithStatus(notFound, 404)).toBe(true);
    expect(isNylasErrorWithStatus(notFound, 429)).toBe(false);
    expect(isNylasErrorWithStatus(new Error("missing"), 404)).toBe(false);
  });
});

describe("hasNylasConfig", () => {
  beforeEach(() => {
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    nylasEnv.NYLAS_CLIENT_ID = "nylas-client-id";
  });

  it("is true when both the API key and client id are set", () => {
    expect(hasNylasConfig()).toBe(true);
  });

  it("is false when the client id is missing", () => {
    nylasEnv.NYLAS_CLIENT_ID = undefined;
    expect(hasNylasConfig()).toBe(false);
  });
});
