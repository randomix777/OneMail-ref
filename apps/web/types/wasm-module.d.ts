/**
 * Wasm imported with the Workers `?module` suffix resolves to a compiled
 * `WebAssembly.Module` instead of bytes. Only the Cloudflare bundler implements
 * it, so the declaration exists for type-checking the Worker entry.
 *
 * This file stays a script (no top-level `import`/`export`): an ambient wildcard
 * module is only a declaration in a script. Inside a module it would be read as
 * an augmentation of an existing module, and augmenting a wildcard is ignored.
 */
declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}

/**
 * Prisma's query compiler, imported once in the Worker entry so every Prisma
 * client instance can reuse it. Set by `cloudflare/worker.ts`.
 */
declare var __prismaQueryCompiler: WebAssembly.Module | undefined;
