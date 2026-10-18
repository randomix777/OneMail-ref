import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  describeNylasTrigger,
  isConfiguredNylasWebhook,
  isValidNylasSignature,
  parseNylasNotification,
} from "@/utils/nylas/webhook";

const SECRET = "webhook-secret";

function sign(rawBody: string, secret = SECRET) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

describe("isValidNylasSignature", () => {
  const rawBody = JSON.stringify({
    type: "message.created",
    data: { grant_id: "grant-1" },
  });

  it("accepts the signature Nylas computes over the body", () => {
    expect(
      isValidNylasSignature({
        rawBody,
        signature: sign(rawBody),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("accepts an upper-case signature", () => {
    expect(
      isValidNylasSignature({
        rawBody,
        signature: sign(rawBody).toUpperCase(),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("rejects a body altered after signing", () => {
    // This is the whole point of signing: a replayed body with a different
    // grant must not verify.
    const tampered = rawBody.replace("grant-1", "grant-2");

    expect(
      isValidNylasSignature({
        rawBody: tampered,
        signature: sign(rawBody),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      isValidNylasSignature({
        rawBody,
        signature: sign(rawBody, "other-secret"),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(
      isValidNylasSignature({ rawBody, signature: null, secret: SECRET }),
    ).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    expect(
      isValidNylasSignature({
        rawBody,
        signature: sign(rawBody),
        secret: undefined,
      }),
    ).toBe(false);
  });
});

describe("parseNylasNotification", () => {
  it("reads the trigger and the grant it belongs to", () => {
    const parsed = parseNylasNotification(
      JSON.stringify({
        type: "message.created",
        data: { grant_id: "grant-1", object: { id: "msg-1" } },
      }),
    );

    expect(parsed).toMatchObject({
      type: "message.created",
      data: { grant_id: "grant-1" },
    });
  });

  it("keeps trigger-specific object fields", () => {
    const parsed = parseNylasNotification(
      JSON.stringify({
        type: "message.created",
        data: { grant_id: "grant-1", object: { id: "msg-1", subject: "Hi" } },
      }),
    );

    expect((parsed?.data.object as { subject?: string })?.subject).toBe("Hi");
  });

  it("rejects a payload with no grant to route on", () => {
    expect(
      parseNylasNotification(JSON.stringify({ type: "message.created" })),
    ).toBeNull();
  });

  it("rejects a body that is not JSON", () => {
    expect(parseNylasNotification("not json")).toBeNull();
  });
});

describe("describeNylasTrigger", () => {
  it("recognizes a created message", () => {
    expect(describeNylasTrigger("message.created")).toEqual({
      trigger: "message.created",
      truncated: false,
      affectsMessage: true,
      affectsGrant: false,
    });
  });

  it("recognizes a truncated payload and strips the suffix", () => {
    // A truncated notification dropped its body, so the object has to be
    // re-fetched by id.
    expect(describeNylasTrigger("message.created.truncated")).toEqual({
      trigger: "message.created",
      truncated: true,
      affectsMessage: true,
      affectsGrant: false,
    });
  });

  it("recognizes a grant trigger", () => {
    expect(describeNylasTrigger("grant.expired")).toMatchObject({
      affectsGrant: true,
      affectsMessage: false,
    });
  });

  it("treats an unrelated trigger as neither message nor grant", () => {
    expect(describeNylasTrigger("calendar.created")).toMatchObject({
      affectsMessage: false,
      affectsGrant: false,
    });
  });
});

describe("isConfiguredNylasWebhook", () => {
  it("is false when the secret is missing", () => {
    expect(isConfiguredNylasWebhook()).toBe(false);
  });
});
