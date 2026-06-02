// Bundle the CLI entry into a single Node-runnable ESM file.
//
// Why: the package's source uses Bun-only niceties at the entry (a `bun`
// shebang, `.ts` execution). The published artifact must run under plain Node
// via `npx headless-tracker`, so we bundle first-party TypeScript into one
// ESM file, keep every npm dependency external (resolved from the consumer's
// node_modules, including the native better-sqlite3 / keyring addons), and
// force a Node shebang on the output.
//
// Runtime asset paths (package.json version, dist/mcp-apps/*.html) are resolved
// at run time via packageRoot(), which walks up to the nearest package.json —
// so they work from this bundle's location (dist/bin/) just as from the dev tree.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const OUT_DIR = "./dist/bin";
const OUT_FILE = `${OUT_DIR}/headless-tracker.mjs`;

const result = await Bun.build({
  entrypoints: ["./bin/headless-tracker.ts"],
  target: "node",
  format: "esm",
  packages: "external", // keep all node_modules deps external (native addons + subpath exports)
  outdir: OUT_DIR,
  naming: "headless-tracker.mjs",
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

// The source entry carries a `#!/usr/bin/env bun` shebang which the bundler may
// preserve. Strip any leading shebang and force the Node one so `npx` works.
let code = readFileSync(OUT_FILE, "utf8");
code = code.replace(/^#![^\n]*\n/, "");
writeFileSync(OUT_FILE, `#!/usr/bin/env node\n${code}`);
chmodSync(OUT_FILE, 0o755);

console.log(`Built ${OUT_FILE} (${(code.length / 1024).toFixed(0)} KB)`);
