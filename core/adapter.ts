import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CaptureSource, StructuredReceipt } from "./contract.ts";

/** stores/<store>/adapter.json */
export interface Manifest {
  store: string;
  displayName: string;
  /** Capture sources in preference order: the first is the richest. */
  sources: CaptureSource[];
  authMethod?: string;
  /** IANA zone the store prints receipt times in. */
  timeZone?: string;
  /** How far back the store's own history goes. */
  retentionDays?: number;
  /** How long after purchase the store takes to publish full detail. */
  detailDelayHours?: number;
  /**
   * How long a receipt known only from a secondary source (email) waits for
   * the primary source (api) before it is uploaded anyway.
   */
  fallbackHoldHours?: number;
  lastVerified?: string;
  notes?: string;
}

/** One receipt exactly as captured, before any interpretation. */
export interface RawReceipt {
  /** The store's receipt ID, canonicalized by the adapter so every source agrees on it. */
  externalId: string;
  captureSource: CaptureSource;
  capturedAt: string;
  /** Verbatim payload: whatever normalize needs to rebuild the receipt without re-fetching. */
  payload: unknown;
}

export interface CaptureOptions {
  /** Inclusive date window, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** Files or directories to read instead of the account's default inbox (file-based sources). */
  paths?: string[];
  /** Re-capture receipts that are already archived. */
  refetch?: boolean;
}

export interface CaptureContext {
  manifest: Manifest;
  accountLabel: string;
  /** Private directory for this account's sessions and settings. */
  accountDir: string;
  /** Default drop folder for file-based sources. */
  inboxDir: string;
  options: CaptureOptions;
  now: Date;
  /** Receipts already archived for this account and source. */
  archived(source: CaptureSource): RawReceipt[];
  log(message: string): void;
}

export type NormalizeResult =
  | { status: "ok"; receipt: StructuredReceipt }
  /** Not ready (detail unpublished) or not a purchase. Left in the archive, retried next run. */
  | { status: "skip"; reason: string };

export interface NormalizeContext {
  manifest: Manifest;
  accountLabel: string;
  timeZone: string;
}

/**
 * What a store folder implements: capture per source, and one normalize
 * shared by all of them. Everything else comes from core.
 */
export interface StoreAdapter {
  capture: Partial<Record<CaptureSource, (ctx: CaptureContext) => AsyncIterable<RawReceipt>>>;
  normalize(raw: RawReceipt, ctx: NormalizeContext): NormalizeResult;
  /** Save a session captured out of band (e.g. a pasted cURL). Returns a one-line status. */
  importSession?(input: string, ctx: { accountDir: string; now: Date }): string;
  /** One-line session state for `status`. */
  sessionStatus?(ctx: { accountDir: string; now: Date }): string;
}

const STORES_DIR = fileURLToPath(new URL("../stores/", import.meta.url));

export function listStores(): string[] {
  return readdirSync(STORES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(`${STORES_DIR}${entry.name}/adapter.json`))
    .map((entry) => entry.name)
    .sort();
}

export async function loadStore(store: string): Promise<{ manifest: Manifest; adapter: StoreAdapter }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(store) || !listStores().includes(store)) {
    throw new Error(`Unknown store "${store}". Known stores: ${listStores().join(", ") || "(none)"}`);
  }
  const manifest = JSON.parse(readFileSync(`${STORES_DIR}${store}/adapter.json`, "utf8")) as Manifest;
  const module = (await import(new URL(`../stores/${store}/index.ts`, import.meta.url).href)) as {
    default: StoreAdapter;
  };
  return { manifest, adapter: module.default };
}
