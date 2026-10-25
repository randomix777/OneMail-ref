import { AsyncLocalStorage } from "node:async_hooks";
import type { SocketsConnect } from "imapflow";

export type CloudflareJob = {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  topic: string;
};

export type CloudflareBindings = {
  HYPERDRIVE?: { connectionString: string };
  JOBS?: {
    send(job: CloudflareJob, options?: { delaySeconds: number }): Promise<void>;
  };
  ASSETS?: { fetch(request: Request): Promise<Response> };
  DOCUMENTS?: { fetch(request: Request): Promise<Response> };
  INTERNAL_API_KEY?: string;
  CRON_SECRET?: string;
  NEXT_PUBLIC_BASE_URL?: string;
};

export type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
};

type RequestScope = {
  bindings: CloudflareBindings;
  connect?: SocketsConnect;
  queueDelivery?: boolean;
  verifiedWebhook?: boolean;
  cleanup: Set<() => void | Promise<void>>;
};

declare global {
  var onemailCloudflareRequestScope:
    | AsyncLocalStorage<RequestScope>
    | undefined;
}

// OpenNext bundles the application separately from the custom Worker entry.
export const cloudflareRequestScope =
  globalThis.onemailCloudflareRequestScope ??
  new AsyncLocalStorage<RequestScope>();
globalThis.onemailCloudflareRequestScope = cloudflareRequestScope;

export function getCloudflareBindings() {
  return cloudflareRequestScope.getStore()?.bindings;
}

export async function dispatchCloudflareRequest(
  request: Request,
  bindings: CloudflareBindings,
  context: WorkerExecutionContext,
  dispatch: (
    request: Request,
    bindings: CloudflareBindings,
    context: WorkerExecutionContext,
  ) => Promise<Response>,
  options?: {
    connect?: SocketsConnect;
    queueDelivery?: boolean;
    verifiedWebhook?: boolean;
  },
): Promise<Response> {
  const scope: RequestScope = { bindings, ...options, cleanup: new Set() };
  const pending = new Set<Promise<unknown>>();
  const trackedContext = new Proxy(context, {
    get(target, key) {
      if (key === "waitUntil") {
        return (promise: Promise<unknown>) => {
          pending.add(promise);
          context.waitUntil(promise);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return cloudflareRequestScope.run(scope, async () => {
    async function waitForBackground() {
      while (pending.size > 0) {
        const batch = [...pending];
        try {
          await Promise.all(batch);
        } finally {
          for (const promise of batch) pending.delete(promise);
        }
      }
    }

    async function close() {
      // next/after may still use the database after the response stream ends.
      while (pending.size > 0) {
        const batch = [...pending];
        await Promise.allSettled(batch);
        for (const promise of batch) pending.delete(promise);
      }
      await Promise.allSettled([...scope.cleanup].map((cleanup) => cleanup()));
    }

    try {
      const response = await dispatch(request, bindings, trackedContext);
      if (!response.body) {
        if (options?.queueDelivery) await waitForBackground();
        context.waitUntil(close());
        return response;
      }

      const reader = response.body.getReader();
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      context.waitUntil(finished.then(close));
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              if (options?.queueDelivery) await waitForBackground();
              controller.close();
              finish();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            controller.error(error);
            finish();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finish();
          }
        },
      });
      return new Response(body, response);
    } catch (error) {
      context.waitUntil(close());
      throw error;
    }
  });
}
