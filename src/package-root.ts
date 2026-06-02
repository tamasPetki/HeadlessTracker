// Resolve the package root (the directory containing package.json) by walking
// up from this module's own location. Used for two things that must not break
// when the code is run from the dev tree, bundled into dist/bin/, or installed
// under node_modules/headless-tracker/:
//   - reading the version out of package.json (server.ts)
//   - locating the bundled MCP App HTML under dist/mcp-apps/ (register.ts)
//
// The previous approach hardcoded a depth-from-root ("../../../.." etc.) which
// only held while the running file stayed at its exact source path. Bundling to
// a single file collapses every import.meta.url to the bundle's location, so the
// counts no longer line up. Walking up to the nearest package.json is robust to
// wherever the (bundled or not) code physically lives.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

let cached: string | null = null;

export function packageRoot(): string {
  if (cached !== null) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, "package.json"))) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  // Fallback: never crash — return where we started looking.
  cached = dirname(fileURLToPath(import.meta.url));
  return cached;
}
