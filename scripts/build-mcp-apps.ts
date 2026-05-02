#!/usr/bin/env bun
// Build the dashboard MCP App into a single self-contained HTML file.
//
// Pipeline:
//   1. `Bun.build` bundles src/mcp/apps/dashboard/iframe.ts (browser target).
//      Pulls in @modelcontextprotocol/ext-apps + zod chunks.
//   2. The bundled JS is minified + ESM-formatted, written to memory.
//   3. We read shell.html, replace the __BUNDLED_JS__ token with the JS, and
//      write the combined HTML to dist/mcp-apps/dashboard.html.
//
// The output file is checked into the repo so users running via `bunx
// headless-tracker` (no build step) still get the dashboard. Re-run this script
// every time iframe.ts or shell.html changes.
//
// Run via: `bun run build:apps` (defined in package.json scripts).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src/mcp/apps/dashboard");
const OUT_DIR = join(ROOT, "dist/mcp-apps");
const OUT_FILE = join(OUT_DIR, "dashboard.html");

console.log("[build-mcp-apps] bundling iframe.ts ...");
const result = await Bun.build({
  entrypoints: [join(SRC_DIR, "iframe.ts")],
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
});

if (!result.success) {
  console.error("[build-mcp-apps] Bun.build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

if (result.outputs.length !== 1) {
  console.error(`[build-mcp-apps] expected 1 output, got ${result.outputs.length}`);
  process.exit(1);
}

const bundledJs = await result.outputs[0]!.text();
const sizeKb = (bundledJs.length / 1024).toFixed(1);
console.log(`[build-mcp-apps] bundle size: ${sizeKb}KB`);

const shell = readFileSync(join(SRC_DIR, "shell.html"), "utf-8");
if (!shell.includes("__BUNDLED_JS__")) {
  console.error("[build-mcp-apps] shell.html missing __BUNDLED_JS__ placeholder");
  process.exit(1);
}

// Replace token. The JS has been minified so it's safe to embed directly inside
// a <script type="module"> tag — but we still escape `</script>` defensively
// in case zod or some dep contains the literal string in a comment that
// minification didn't strip.
const escapedJs = bundledJs.replace(/<\/script/gi, "<\\/script");
// IMPORTANT: pass the replacement as a function, not a string. String.replace
// interprets `$&`, `$1`, etc. inside string-replacements specially, and the
// minified bundle contains `\\$&` (a regex backreference for `String.prototype.replace`).
// Function form sidesteps the special-pattern interpretation entirely.
const html = shell.replace("__BUNDLED_JS__", () => escapedJs);

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, html, "utf-8");
const totalKb = (html.length / 1024).toFixed(1);
console.log(`[build-mcp-apps] wrote ${OUT_FILE} (${totalKb}KB)`);
