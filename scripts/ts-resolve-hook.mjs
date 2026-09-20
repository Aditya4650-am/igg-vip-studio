/**
 * Node ESM resolver hook so `node --experimental-strip-types --test` can import
 * the app's server modules.
 *
 * Those modules use bundler-style extensionless relative imports
 * (`./vars.server`), which Vite resolves but Node's ESM loader treats as an
 * exact file name. Without this hook no `src/lib/server/**` module can be
 * imported from a test.
 *
 * Usage: `node --import ./scripts/ts-resolve-hook.mjs ...`
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANDIDATES = [".ts", ".tsx", ".mts", ".js", ".mjs"];

/** Mirrors the `@/* -> ./src/*` alias from tsconfig.json. */
const SRC_ROOT = new URL("../src/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = new URL(specifier.slice(2), SRC_ROOT).href;
    return resolveFrom(target, context, nextResolve);
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/")
      ? pathToFileURL(specifier).href
      : new URL(specifier, context.parentURL).href;
    return resolveFrom(base, context, nextResolve);
  }
  return nextResolve(specifier, context);
}

async function resolveFrom(base, context, nextResolve) {
  const path = fileURLToPath(base);
  if (!existsSync(path)) {
    for (const ext of CANDIDATES) {
      const candidate = path + ext;
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    for (const ext of CANDIDATES) {
      const candidate = `${path}/index${ext}`;
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
  }
  return nextResolve(base, context);
}