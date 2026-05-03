#!/usr/bin/env bun
// Build all MCP App iframes into single self-contained HTML files.
//
// Pipeline (per app):
//   1. `Bun.build` bundles iframe.ts (browser target). Pulls in
//      @modelcontextprotocol/ext-apps + zod chunks.
//   2. The bundled JS is minified + ESM-formatted, written to memory.
//   3. We read shell.html, replace the __BUNDLED_JS__ token with the JS, and
//      write the combined HTML to dist/mcp-apps/<app>.html.
//
// Output files are checked into the repo so users running via `bunx
// headless-tracker` (no build step) still get the apps. Re-run this script
// every time any iframe.ts or shell.html changes.
//
// Run via: `bun run build:apps` (defined in package.json scripts).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APPS_DIR = join(ROOT, "src/mcp/apps");
const OUT_DIR = join(ROOT, "dist/mcp-apps");

interface AppSpec {
  name: string;     // becomes <name>.html in dist/
  srcDir: string;   // src directory containing iframe.ts + shell.html
}

const APPS: AppSpec[] = [
  { name: "dashboard", srcDir: join(APPS_DIR, "dashboard") },
  { name: "settings",  srcDir: join(APPS_DIR, "settings") },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const app of APPS) {
  console.log(`[build-mcp-apps] bundling ${app.name}/iframe.ts ...`);
  const result = await Bun.build({
    entrypoints: [join(app.srcDir, "iframe.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
  });

  if (!result.success) {
    console.error(`[build-mcp-apps] Bun.build failed for ${app.name}:`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  if (result.outputs.length !== 1) {
    console.error(`[build-mcp-apps] ${app.name}: expected 1 output, got ${result.outputs.length}`);
    process.exit(1);
  }

  const bundledJs = await result.outputs[0]!.text();
  const sizeKb = (bundledJs.length / 1024).toFixed(1);
  console.log(`[build-mcp-apps]   ${app.name} bundle size: ${sizeKb}KB`);

  const shell = readFileSync(join(app.srcDir, "shell.html"), "utf-8");
  if (!shell.includes("__BUNDLED_JS__")) {
    console.error(`[build-mcp-apps] ${app.name}/shell.html missing __BUNDLED_JS__ placeholder`);
    process.exit(1);
  }

  // Replace token. Defensively escape `</script` in case zod or some dep
  // contains the literal string in a comment that minification didn't strip.
  const escapedJs = bundledJs.replace(/<\/script/gi, "<\\/script");
  // IMPORTANT: pass the replacement as a function, not a string. String.replace
  // interprets `$&`, `$1`, etc. inside string-replacements specially, and the
  // minified bundle contains `\\$&` (a regex backreference). Function form
  // sidesteps pattern interpretation entirely.
  const html = shell.replace("__BUNDLED_JS__", () => escapedJs);

  const outFile = join(OUT_DIR, `${app.name}.html`);
  writeFileSync(outFile, html, "utf-8");
  const totalKb = (html.length / 1024).toFixed(1);
  console.log(`[build-mcp-apps]   wrote ${outFile} (${totalKb}KB)`);
}

console.log(`[build-mcp-apps] done — ${APPS.length} app(s) built`);
