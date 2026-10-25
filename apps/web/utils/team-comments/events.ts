import "server-only";
import { EventEmitter } from "node:events";
import Redis from "ioredis";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";
import { cloudflareRequestScope } from "@/utils/cloudflare/context";

declare global {
  var teamConversationEvents: EventEmitter | undefined;
  var teamConversationPublisher: Redis | undefined;
}

const localEvents = global.teamConversationEvents ?? new EventEmitter();
const requestPublishers = new WeakMap<object, Redis>();
global.teamConversationEvents = localEvents;

export function conversationChangeChannel(conversationId: string) {
  return `team-comments:${conversationId}`;
}

// With Redis configured, every stream listens on Redis, so the in-process
// emitter is only the fallback for single-process installs without it.
export async function publishConversationChange(
  conversationId: string,
  logger: Logger,
) {
  if (!env.REDIS_URL) {
    localEvents.emit(conversationChangeChannel(conversationId));
    return;
  }
  try {
    await getPublisher(env.REDIS_URL).publish(
      conversationChangeChannel(conversationId),
      "{}",
    );
  } catch (error) {
    logger.warn("Unable to publish conversation invalidation", { error });
  }
}

export function subscribeLocalConversationChange(
  conversationId: string,
  listener: () => void,
) {
  const channel = conversationChangeChannel(conversationId);
  localEvents.on(channel, listener);
  return () => localEvents.off(channel, listener);
}

// Publish on the same Redis that streams subscribe to, over one reused
// connection with bounded retries so a slow Redis cannot stall mutations.
function getPublisher(url: string) {
  const scope = cloudflareRequestScope.getStore();
  if (scope) {
    const existing = requestPublishers.get(scope);
    if (existing) return existing;
    const publisher = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: () => null,
    });
    publisher.on("error", () => {});
    scope.cleanup.add(() => publisher.disconnect());
    requestPublishers.set(scope, publisher);
    return publisher;
  }
  if (!global.teamConversationPublisher) {
    global.teamConversationPublisher = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    // Failures surface on publish, where they are logged.
    global.teamConversationPublisher.on("error", () => {});
  }
  return global.teamConversationPublisher;
}
