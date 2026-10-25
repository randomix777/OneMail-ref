import "server-only";
import sanitizeHtml from "sanitize-html";
import { cloudflareRequestScope } from "@/utils/cloudflare/context";
import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";
import { createEmailProvider } from "@/utils/email/provider";
import { isThreadNotFoundError } from "@/utils/email/thread-not-found";
import type { EmailThread } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import { extractErrorInfo as extractGmailErrorInfo } from "@/utils/gmail/retry";
import { extractErrorInfo as extractOutlookErrorInfo } from "@/utils/outlook/retry";
import {
  getAuthorizedConversation,
  type ConversationActor,
} from "@/utils/team-comments/access";

const inFlight = new Map<string, Promise<EmailThread>>();
const requestFlights = new WeakMap<object, Map<string, Promise<EmailThread>>>();

export async function getSharedMessages(
  actor: ConversationActor,
  conversationId: string,
  logger: Logger,
) {
  const { conversation } = await getAuthorizedConversation(
    actor,
    conversationId,
  );
  const emailAccount = conversation.publisher.emailAccount;
  if (emailAccount.account.disconnectedAt)
    return { status: "unavailable" as const, reason: "reconnect" as const };
  try {
    const thread = await fetchCompleteThread({
      emailAccountId: emailAccount.id,
      provider: emailAccount.account.provider,
      threadId: conversation.threadId,
      logger,
    });
    const latest = await getAuthorizedConversation(actor, conversationId);
    if (latest.conversation.generation !== conversation.generation)
      throw new Error("Conversation access changed during provider read");
    return {
      status: "available" as const,
      complete: true,
      messages: getVisibleMessages(thread.messages, conversation.threadId).map(
        (message, index) =>
          projectMessage(message, index, conversationId, actor.memberId),
      ),
    };
  } catch (error) {
    await getAuthorizedConversation(actor, conversationId);
    const reason = classifyContentError(error, emailAccount.account.provider);
    logger.warn("Shared conversation email unavailable", { reason });
    logger.trace("Shared conversation email unavailable details", { error });
    return {
      status: "unavailable" as const,
      reason,
    };
  }
}

export async function getSharedAttachment(
  actor: ConversationActor,
  input: {
    conversationId: string;
    attachmentRef: string;
    logger: Logger;
  },
) {
  const { conversation } = await getAuthorizedConversation(
    actor,
    input.conversationId,
  );
  const match = /^(\d+):(\d+)$/.exec(input.attachmentRef);
  if (!match) return null;
  const emailAccount = conversation.publisher.emailAccount;
  if (emailAccount.account.disconnectedAt) return null;
  const thread = await fetchCompleteThread({
    emailAccountId: emailAccount.id,
    provider: emailAccount.account.provider,
    threadId: conversation.threadId,
    logger: input.logger,
  });
  const messages = getVisibleMessages(thread.messages, conversation.threadId);
  const message = messages[Number(match[1])];
  const attachments = message
    ? [...(message.attachments ?? []), ...message.inline]
    : [];
  const attachment = attachments[Number(match[2])];
  if (!message || !attachment) return null;
  const provider = await createEmailProvider({
    emailAccountId: emailAccount.id,
    provider: emailAccount.account.provider,
    logger: input.logger,
  });
  const stream = await provider.getAttachmentStream(
    message.id,
    attachment.attachmentId,
  );
  const latest = await getAuthorizedConversation(actor, input.conversationId);
  if (latest.conversation.generation !== conversation.generation) return null;
  return {
    stream,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

function projectMessage(
  message: ParsedMessage,
  index: number,
  conversationId: string,
  memberId: string,
) {
  const attachments = [...(message.attachments ?? []), ...message.inline];
  const safeAttachments = attachments.map((attachment, attachmentIndex) => ({
    ref: `${index}:${attachmentIndex}`,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    url: `/api/team-comments/conversations/${conversationId}/attachments/${index}:${attachmentIndex}?memberId=${encodeURIComponent(memberId)}`,
  }));
  const html = message.textHtml
    ? sanitizeSharedHtml(
        message.textHtml,
        message,
        index,
        conversationId,
        memberId,
      )
    : null;
  return {
    ref: String(index),
    from: message.headers.from,
    to: message.headers.to,
    cc: message.headers.cc ?? "",
    subject: message.headers.subject,
    date: message.date,
    text: message.textPlain ?? "",
    html,
    attachments: safeAttachments,
  };
}

function sanitizeSharedHtml(
  html: string,
  message: ParsedMessage,
  index: number,
  conversationId: string,
  memberId: string,
) {
  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img"],
    nonTextTags: ["style", "script", "textarea", "option", "svg", "math"],
    allowedAttributes: {
      "*": ["title", "dir", "lang"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowProtocolRelative: false,
    transformTags: {
      img: (tagName, attributes) => {
        const { src: source = "", ...safeAttributes } = attributes;
        if (!source.toLowerCase().startsWith("cid:"))
          return { tagName, attribs: safeAttributes };
        const cid = source.slice(4).replace(/^<|>$/g, "").toLowerCase();
        const inlineIndex = message.inline.findIndex(
          (attachment) =>
            attachment.headers["content-id"]
              .replace(/^<|>$/g, "")
              .toLowerCase() === cid,
        );
        if (inlineIndex < 0) return { tagName, attribs: safeAttributes };
        return {
          tagName,
          attribs: {
            ...safeAttributes,
            src: `/api/team-comments/conversations/${conversationId}/attachments/${index}:${(message.attachments?.length ?? 0) + inlineIndex}?memberId=${encodeURIComponent(memberId)}`,
          },
        };
      },
    },
  });
}

function getVisibleMessages(
  messages: EmailThread["messages"],
  threadId: string,
) {
  return messages.filter(
    (message) => message.threadId === threadId && !isDraft(message),
  );
}

async function fetchCompleteThread(input: {
  emailAccountId: string;
  provider: string;
  threadId: string;
  logger: Logger;
}) {
  const scope = cloudflareRequestScope.getStore();
  let pending = inFlight;
  if (scope) {
    pending = requestFlights.get(scope) ?? new Map();
    requestFlights.set(scope, pending);
  }
  const key = `${input.emailAccountId}:${input.threadId}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const provider = await createEmailProvider({
      emailAccountId: input.emailAccountId,
      provider: input.provider,
      logger: input.logger,
    });
    return provider.getThread(input.threadId, { complete: true });
  })();
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    if (pending.get(key) === promise) pending.delete(key);
  }
}

function isDraft(message: ParsedMessage) {
  return message.labelIds?.includes("DRAFT") ?? false;
}

function classifyContentError(
  error: unknown,
  provider: string,
): "rate-limited" | "reconnect" | "missing" | "unknown" {
  if (isEmailProviderRateLimitError({ error, provider })) return "rate-limited";
  if (isThreadNotFoundError(error)) return "missing";
  const status = Number(
    extractOutlookErrorInfo(error).status ??
      extractGmailErrorInfo(error).status,
  );
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "reconnect";
  if (status === 404) return "missing";
  return "unknown";
}
