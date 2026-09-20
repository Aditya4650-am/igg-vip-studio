/**
 * Registers the TypeScript-aware resolver hook for Node's test runner.
 *
 * Usage: `node --import ./scripts/register-ts-resolve.mjs --experimental-strip-types --test ...`
 * See `ts-resolve-hook.mjs` for why the app's server modules need it.
 */

import { register } from "node:module";

register("./ts-resolve-hook.mjs", import.meta.url);