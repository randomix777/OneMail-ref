import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteNylasMessage,
  getNylasMessage,
  listNylasMessages,
  listNylasThreadMessages,
  sendNylasMessage,
  updateNylasMessage,
} from "@/utils/nylas/mail";

const { nylasEnv } = vi.hoisted(() => ({
  nylasEnv: {
    NYLAS_API_KEY: "nylas-api-key" as string | undefined,
    NYLAS_API_URI: "https://api.us.nylas.com",
  },
}));

vi.mock("@/env", () => ({ env: nylasEnv }));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(call = 0) {
  return new URL(fetchMock.mock.calls[call][0] as string);
}

function requestBody(call = 0) {
  const init = fetchMock.mock.calls[call][1] as { body?: string };
  return init.body ? JSON.parse(init.body) : undefined;
}

describe("listNylasMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns the page and its cursor", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: "msg-1" }], next_cursor: "cursor-2" }),
    );

    await expect(listNylasMessages({ grantId: "grant-1" })).resolves.toEqual({
      messages: [{ id: "msg-1" }],
      nextCursor: "cursor-2",
    });
  });

  it("treats a missing payload as an empty page", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(listNylasMessages({ grantId: "grant-1" })).resolves.toEqual({
      messages: [],
      nextCursor: null,
    });
  });

  it("translates query filters into Nylas parameter names", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await listNylasMessages({
      grantId: "grant-1",
      query: {
        in: "INBOX",
        unread: true,
        hasAttachment: true,
        threadId: "thread-1",
        searchQueryNative: "from:ada@example.com",
        limit: 20,
        pageToken: "cursor-2",
        fields: "include_basic_headers",
      },
    });

    const url = requestUrl();
    expect(url.pathname).toBe("/v3/grants/grant-1/messages");
    expect(url.searchParams.get("in")).toBe("INBOX");
    expect(url.searchParams.get("unread")).toBe("true");
    expect(url.searchParams.get("has_attachment")).toBe("true");
    expect(url.searchParams.get("thread_id")).toBe("thread-1");
    expect(url.searchParams.get("search_query_native")).toBe(
      "from:ada@example.com",
    );
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("page_token")).toBe("cursor-2");
    expect(url.searchParams.get("fields")).toBe("include_basic_headers");
  });

  it("converts date bounds to Unix seconds", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await listNylasMessages({
      grantId: "grant-1",
      query: {
        receivedAfter: new Date("2026-01-01T00:00:00.000Z"),
        receivedBefore: new Date("2026-01-02T00:00:00.000Z"),
      },
    });

    const url = requestUrl();
    expect(url.searchParams.get("received_after")).toBe(
      String(Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000)),
    );
    expect(url.searchParams.get("received_before")).toBe(
      String(Math.floor(Date.parse("2026-01-02T00:00:00.000Z") / 1000)),
    );
  });

  it("omits filters that were not asked for", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await listNylasMessages({ grantId: "grant-1", query: { in: "INBOX" } });

    const url = requestUrl();
    expect(url.searchParams.get("in")).toBe("INBOX");
    expect(url.searchParams.has("unread")).toBe(false);
    expect(url.searchParams.has("received_after")).toBe(false);
    expect(url.searchParams.has("fields")).toBe(false);
  });
});

describe("getNylasMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("asks for the threading headers and parses the message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          id: "msg-1",
          thread_id: "thread-1",
          folders: ["INBOX"],
          unread: true,
          headers: [{ name: "Message-ID", value: "<abc@example.com>" }],
        },
      }),
    );

    const parsed = await getNylasMessage({
      grantId: "grant-1",
      messageId: "msg-1",
    });

    expect(requestUrl().searchParams.get("fields")).toBe(
      "include_basic_headers",
    );
    expect(parsed?.id).toBe("msg-1");
    expect(parsed?.headers["message-id"]).toBe("<abc@example.com>");
  });

  it("escapes a message id that is not URL safe", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: "a/b" } }));

    await getNylasMessage({ grantId: "grant-1", messageId: "a/b" });

    expect(requestUrl().pathname).toBe("/v3/grants/grant-1/messages/a%2Fb");
  });

  it("returns null when the message is gone", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(
      getNylasMessage({ grantId: "grant-1", messageId: "msg-1" }),
    ).resolves.toBeNull();
  });
});

describe("listNylasThreadMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("collects every page of a thread", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "msg-1" }], next_cursor: "cursor-2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "msg-2" }] }));

    await expect(
      listNylasThreadMessages({ grantId: "grant-1", threadId: "thread-1" }),
    ).resolves.toEqual([{ id: "msg-1" }, { id: "msg-2" }]);

    expect(requestUrl(0).searchParams.get("thread_id")).toBe("thread-1");
    expect(requestUrl(1).searchParams.get("page_token")).toBe("cursor-2");
  });
});

describe("updateNylasMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("sends only the fields the caller wants to change", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: "msg-1" } }));

    await updateNylasMessage({
      grantId: "grant-1",
      messageId: "msg-1",
      folders: ["TRASH"],
    });

    expect(requestBody()).toEqual({ folders: ["TRASH"] });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT" });
  });

  it("can clear a flag as well as set it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: "msg-1" } }));

    await updateNylasMessage({
      grantId: "grant-1",
      messageId: "msg-1",
      unread: false,
      starred: false,
    });

    expect(requestBody()).toEqual({ unread: false, starred: false });
  });
});

describe("deleteNylasMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("deletes by id", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await deleteNylasMessage({ grantId: "grant-1", messageId: "msg-1" });

    expect(requestUrl().pathname).toBe("/v3/grants/grant-1/messages/msg-1");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });
});

describe("sendNylasMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns the sent message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { id: "msg-sent", thread_id: "thread-1" } }),
    );

    await expect(
      sendNylasMessage({
        grantId: "grant-1",
        body: {
          to: [{ email: "ada@example.com" }],
          subject: "Hi",
          body: "<p>Hi</p>",
        },
      }),
    ).resolves.toMatchObject({ id: "msg-sent" });
  });

  it("maps the request onto Nylas' field names", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: "msg-sent" } }));

    await sendNylasMessage({
      grantId: "grant-1",
      body: {
        to: [{ name: "Ada", email: "ada@example.com" }],
        cc: [{ email: "cc@example.com" }],
        from: [{ name: "Me", email: "me@example.com" }],
        subject: "Re: Hi",
        body: "Reply",
        isPlaintext: true,
        replyToMessageId: "msg-1",
      },
    });

    expect(requestBody()).toEqual({
      to: [{ name: "Ada", email: "ada@example.com" }],
      cc: [{ email: "cc@example.com" }],
      from: [{ name: "Me", email: "me@example.com" }],
      subject: "Re: Hi",
      body: "Reply",
      is_plaintext: true,
      reply_to_message_id: "msg-1",
    });
  });

  it("maps attachments onto Nylas' schema", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: "msg-sent" } }));

    await sendNylasMessage({
      grantId: "grant-1",
      body: {
        to: [{ email: "ada@example.com" }],
        attachments: [
          {
            filename: "logo.png",
            contentType: "image/png",
            content: "YmFzZTY0",
            contentId: "logo@example.com",
          },
        ],
      },
    });

    expect(requestBody().attachments).toEqual([
      {
        filename: "logo.png",
        content_type: "image/png",
        content: "YmFzZTY0",
        content_id: "logo@example.com",
      },
    ]);
  });

  it("fails loudly when Nylas accepts a send but returns no message", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));

    await expect(
      sendNylasMessage({
        grantId: "grant-1",
        body: { to: [{ email: "ada@example.com" }] },
      }),
    ).rejects.toThrow("Nylas accepted the send but returned no message id");
  });
});
