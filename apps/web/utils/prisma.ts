import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@/env";
import { PrismaClient } from "@/generated/prisma/client";
import { encryptedTokens } from "@/utils/prisma-extensions";
import { auditPrismaQueries } from "@/utils/audit/prisma-extension";
import { cloudflareRequestScope } from "@/utils/cloudflare/context";

declare global {
  var prisma: PrismaClient | undefined;
}

const _prisma =
  global.prisma ||
  createPrismaClient(env.PREVIEW_DATABASE_URL ?? env.DATABASE_URL);

if (env.NODE_ENV === "development") global.prisma = _prisma;

const requestClients = new WeakMap<object, PrismaClient>();

const requestAwarePrisma = new Proxy(_prisma, {
  get(target, property) {
    const scope = cloudflareRequestScope.getStore();
    let client = target;
    if (scope) {
      const existing = requestClients.get(scope);
      if (existing) {
        client = existing;
      } else {
        const connectionString = scope.bindings.HYPERDRIVE?.connectionString;
        if (!connectionString) {
          throw new Error("Cloudflare HYPERDRIVE binding is required");
        }
        client = createPrismaClient(connectionString);
        requestClients.set(scope, client);
        const requestClient = client;
        scope.cleanup.add(() => requestClient.$disconnect());
      }
    }
    const value: unknown = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export default requestAwarePrisma;

function createPrismaClient(connectionString: string) {
  // Keep the existing public Prisma type while applying runtime-only extensions.
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10_000,
    }),
  })
    .$extends(encryptedTokens)
    .$extends(auditPrismaQueries) as unknown as PrismaClient;
}
