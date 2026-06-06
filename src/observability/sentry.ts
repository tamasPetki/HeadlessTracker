// Dependency-free Sentry client.
//
// We deliberately do NOT depend on `@sentry/node`: the SDK pulls ~20 packages
// (the whole OpenTelemetry auto-instrumentation stack) and ~45MB for what is
// ultimately one HTTP POST of an error event. That contradicts this package's
// lean, zero-runtime-deps pitch (the same reason we dropped `bybit-api` in
// v1.0.6). Sentry's ingestion needs no SDK: it is a POST of an "envelope" to a
// DSN-derived endpoint, self-authenticating via the DSN in the envelope header.
// See decisions.md (2026-06-05) for the full rationale.
//
// PRIVACY (hard rule): this never sends user portfolio data. No asset amounts,
// wallet/proxy addresses, API keys, account labels, or balances. Only the error
// class, a scrubbed message, a scrubbed stack, and the connector id / operation.
// Error strings are run through scrub() to redact anything address- or key-like
// defensively, even though connector errors don't normally carry such data.
//
// Capture is best-effort and MUST NEVER throw or meaningfully block the caller:
// all failures are swallowed, and the POST has a short timeout.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "../package-root.ts";

interface SentryClient {
  dsn: string;          // full DSN, embedded in the envelope header for auth
  envelopeUrl: string;  // https://<host>/api/<projectId>/envelope/
  release: string;
}

// undefined = not yet configured; null = configured and disabled (no DSN).
let client: SentryClient | null | undefined;

function readVersion(): string {
  try {
    const { version } = JSON.parse(
      readFileSync(join(packageRoot(), "package.json"), "utf8")
    ) as { version?: string };
    return version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildClient(dsn: string, release?: string): SentryClient | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+/, "").split("/").pop();
    if (!u.username || !projectId) return null;
    return {
      dsn,
      envelopeUrl: `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
      release: release ?? readVersion(),
    };
  } catch {
    return null; // malformed DSN → stay disabled rather than crash
  }
}

/**
 * Configure Sentry. Call once at startup. With no DSN (the default for end
 * users) Sentry is disabled and every capture is a no-op. Reads SENTRY_DSN from
 * the environment when `dsn` is omitted.
 */
export function initSentry(dsn: string | undefined = process.env.SENTRY_DSN, release?: string): void {
  client = dsn ? buildClient(dsn, release) : null;
}

export function isSentryEnabled(): boolean {
  if (client === undefined) initSentry();
  return client !== null;
}

// Redact address- and key-like substrings. Defensive: connector error messages
// don't normally contain these, but we never want to be the reason one leaks.
export function scrub(input: string): string {
  return input
    .replace(/0x[a-fA-F0-9]{40}\b/g, "0x<redacted>")           // EVM addresses
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "<redacted>") // base58 (Solana addr / keys)
    .replace(/[/\\](?:Users|home)[/\\][^/\\]+/g, "/~");        // strip OS username from paths
}

// Parse a Node Error.stack into Sentry stack frames (best-effort).
function parseStack(stack: string | undefined): Array<Record<string, unknown>> {
  if (!stack) return [];
  const frames: Array<Record<string, unknown>> = [];
  for (const line of stack.split("\n")) {
    // "    at fnName (/path/file.ts:12:5)"  or  "    at /path/file.ts:12:5"
    const m = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    frames.push({
      function: m[1] ? scrub(m[1]) : "<anonymous>",
      filename: scrub(m[2]!),
      lineno: parseInt(m[3]!, 10),
      colno: parseInt(m[4]!, 10),
      in_app: m[2]!.includes("headless-tracker") || m[2]!.includes("/src/"),
    });
  }
  // Sentry expects frames oldest-first; Node stacks are newest-first.
  return frames.reverse();
}

export interface CaptureContext {
  connector?: string;
  operation?: string;
}

function eventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function tagsFrom(ctx?: CaptureContext): Record<string, string> {
  const tags: Record<string, string> = {};
  if (ctx?.connector) tags.connector = ctx.connector;
  if (ctx?.operation) tags.operation = ctx.operation;
  return tags;
}

async function send(c: SentryClient, event: Record<string, unknown>): Promise<void> {
  const id = event.event_id as string;
  const header = JSON.stringify({ event_id: id, sent_at: new Date().toISOString(), dsn: c.dsn });
  const itemHeader = JSON.stringify({ type: "event", content_type: "application/json" });
  const body = `${header}\n${itemHeader}\n${JSON.stringify(event)}\n`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(c.envelopeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report an unexpected exception. No-op when Sentry is disabled. Never throws.
 * Best-effort: failures (network, timeout, disabled) are swallowed.
 */
export async function captureException(error: unknown, ctx?: CaptureContext): Promise<void> {
  if (client === undefined) initSentry();
  const c = client;
  if (!c) return;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const event = {
      event_id: eventId(),
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      release: c.release,
      sdk: { name: "headless-tracker.inhouse", version: c.release },
      exception: {
        values: [
          {
            type: err.name || "Error",
            value: scrub(err.message || String(error)),
            stacktrace: { frames: parseStack(err.stack) },
          },
        ],
      },
      tags: tagsFrom(ctx),
    };
    await send(c, event);
  } catch {
    // Telemetry must never break the app.
  }
}

/**
 * Report a noteworthy message (e.g. an upstream API returning an unexpected
 * shape). No-op when disabled. Never throws.
 */
export async function captureMessage(
  message: string,
  ctx?: CaptureContext,
  level: "error" | "warning" | "info" = "error"
): Promise<void> {
  if (client === undefined) initSentry();
  const c = client;
  if (!c) return;
  try {
    const event = {
      event_id: eventId(),
      timestamp: Date.now() / 1000,
      platform: "node",
      level,
      release: c.release,
      sdk: { name: "headless-tracker.inhouse", version: c.release },
      message: { formatted: scrub(message) },
      tags: tagsFrom(ctx),
    };
    await send(c, event);
  } catch {
    // Telemetry must never break the app.
  }
}
