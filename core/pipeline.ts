import type { CaptureOptions, Manifest, RawReceipt, StoreAdapter } from "./adapter.ts";
import type { AccountArchive } from "./archive.ts";
import { CONTRACT_VERSION, reconcile, validateRecord, type CaptureSource, type ReceiptRecord } from "./contract.ts";
import { FoodFlowError, type FoodFlowClient } from "./foodflow.ts";

/**
 * The run pipeline: capture -> normalize -> validate -> upload. Each stage
 * reads what the previous one left on disk, so any stage can be re-run alone:
 * normalize after a parser fix without re-fetching, upload after FoodFlow
 * comes back up without re-normalizing.
 */

export interface Loaded {
  manifest: Manifest;
  adapter: StoreAdapter;
}

type Log = (message: string) => void;

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

export interface CaptureSummary {
  sources: Record<string, { captured: number; alreadyArchived: number; error?: string }>;
}

export async function capture(
  loaded: Loaded,
  archive: AccountArchive,
  opts: { sources?: CaptureSource[]; options?: CaptureOptions; now?: Date; log?: Log } = {}
): Promise<CaptureSummary> {
  const { manifest, adapter } = loaded;
  const log = opts.log ?? (() => {});
  const options = opts.options ?? {};
  const sources = opts.sources ?? manifest.sources.filter((s) => adapter.capture[s]);
  const summary: CaptureSummary = { sources: {} };

  for (const source of sources) {
    const run = adapter.capture[source];
    if (!run) throw new Error(`${manifest.displayName} has no "${source}" capture.`);
    const counts: CaptureSummary["sources"][string] = { captured: 0, alreadyArchived: 0 };
    summary.sources[source] = counts;
    try {
      const ctx = {
        manifest,
        accountLabel: archive.accountLabel,
        accountDir: archive.accountDir,
        inboxDir: archive.inboxDir,
        options,
        now: opts.now ?? new Date(),
        archived: (s: CaptureSource) => archive.listRaw(s),
        log,
      };
      for await (const raw of run(ctx)) {
        if (raw.captureSource !== source) throw new Error(`${source} capture yielded a "${raw.captureSource}" receipt`);
        if (archive.hasRaw(raw.externalId, source) && !options.refetch) {
          counts.alreadyArchived++;
          continue;
        }
        // Archived before anything interprets it: see archive.ts.
        archive.writeRaw(raw);
        counts.captured++;
      }
    } catch (err) {
      // One source failing (an expired token) must not stop the others: that
      // is the point of a store having a fallback source.
      counts.error = (err as Error).message;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// normalize + validate
// ---------------------------------------------------------------------------

export interface NormalizeSummary {
  records: ReceiptRecord[];
  skipped: { externalId: string; reason: string }[];
  invalid: { externalId: string; problems: string[] }[];
  /** Valid records whose lines + tax don't add up to the printed total. FoodFlow will mark them needs_review. */
  unreconciled: { externalId: string; differenceCents: number }[];
}

export function normalize(loaded: Loaded, archive: AccountArchive): NormalizeSummary {
  const { manifest, adapter } = loaded;
  const timeZone = manifest.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rank = (source: CaptureSource) => {
    const i = manifest.sources.indexOf(source);
    return i === -1 ? manifest.sources.length : i;
  };

  const byId = new Map<string, RawReceipt[]>();
  for (const raw of archive.listRaw()) {
    const group = byId.get(raw.externalId) ?? [];
    group.push(raw);
    byId.set(raw.externalId, group);
  }

  const summary: NormalizeSummary = { records: [], skipped: [], invalid: [], unreconciled: [] };
  for (const [externalId, group] of byId) {
    group.sort((a, b) => rank(a.captureSource) - rank(b.captureSource));
    // Richest source first; fall through to the next when it isn't ready
    // (an API detail that hasn't published) or throws on a format it no
    // longer understands.
    let record: ReceiptRecord | null = null;
    const reasons: string[] = [];
    for (const raw of group) {
      try {
        const result = adapter.normalize(raw, { manifest, accountLabel: archive.accountLabel, timeZone });
        if (result.status === "skip") {
          reasons.push(`${raw.captureSource}: ${result.reason}`);
          continue;
        }
        record = {
          contractVersion: CONTRACT_VERSION,
          externalSource: manifest.store,
          externalId,
          accountLabel: archive.accountLabel,
          capturedAt: raw.capturedAt,
          captureSource: raw.captureSource,
          ...result.receipt,
        };
        break;
      } catch (err) {
        reasons.push(`${raw.captureSource}: normalize failed: ${(err as Error).message}`);
      }
    }
    if (!record) {
      summary.skipped.push({ externalId, reason: reasons.join("; ") });
      continue;
    }
    const problems = validateRecord(record);
    if (problems.length > 0) {
      summary.invalid.push({ externalId, problems });
      continue;
    }
    const { differenceCents } = reconcile(record);
    if (differenceCents !== null && Math.abs(differenceCents) > 2) {
      summary.unreconciled.push({ externalId, differenceCents });
    }
    summary.records.push(record);
  }

  summary.records.sort((a, b) => a.purchasedAt.localeCompare(b.purchasedAt) || a.externalId.localeCompare(b.externalId));
  archive.writeNormalized(summary.records);
  return summary;
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

export interface UploadSummary {
  uploaded: { externalId: string; receiptId: string; parseStatus: string }[];
  /** FoodFlow already had it (uploaded by another run, or ingested through its own email path). */
  duplicates: string[];
  alreadyUploaded: number;
  /** Known only from a fallback source and still inside the hold window for the primary one. */
  held: string[];
  /** Uploaded earlier from a fallback source; a richer capture exists now but FoodFlow keeps the first. */
  richerNotApplied: string[];
  /** Stored by FoodFlow but held out of inventory as a lookalike of a receipt with no external ID. */
  probableDuplicates: { externalId: string; receiptId: string; of: string }[];
  failed: { externalId: string; error: string }[];
  dryRun: boolean;
  /** Set when the run stopped early (FoodFlow unreachable, token rejected, contract mismatch). */
  aborted?: string;
}

const FATAL = new Set(["unreachable", "unauthorized", "forbidden_scope", "contract_unsupported"]);

export async function upload(
  loaded: Loaded,
  archive: AccountArchive,
  records: ReceiptRecord[],
  client: FoodFlowClient | null,
  opts: { dryRun?: boolean; holdHours?: number; now?: Date; log?: Log } = {}
): Promise<UploadSummary> {
  const { manifest } = loaded;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const summary: UploadSummary = {
    uploaded: [],
    duplicates: [],
    alreadyUploaded: 0,
    held: [],
    richerNotApplied: [],
    probableDuplicates: [],
    failed: [],
    dryRun,
  };

  const primary = manifest.sources[0];
  const holdMs = (opts.holdHours ?? manifest.fallbackHoldHours ?? 0) * 3_600_000;
  // The hold only makes sense for an account that actually uses the primary
  // source; an email-only account would otherwise wait for an API capture
  // that is never coming.
  const usesPrimary = primary !== undefined && archive.listRaw(primary).length > 0;
  const rank = (source: CaptureSource) => manifest.sources.indexOf(source);

  const ledger = archive.readLedger();
  const pending: ReceiptRecord[] = [];
  for (const record of records) {
    const done = ledger[record.externalId];
    if (done) {
      summary.alreadyUploaded++;
      if (rank(record.captureSource) < rank(done.captureSource)) summary.richerNotApplied.push(record.externalId);
      continue;
    }
    const age = now.getTime() - Date.parse(record.purchasedAt);
    if (record.captureSource !== primary && usesPrimary && age < holdMs) {
      summary.held.push(record.externalId);
      continue;
    }
    pending.push(record);
  }

  if (pending.length === 0) return summary;
  if (dryRun) {
    for (const record of pending) {
      summary.uploaded.push({ externalId: record.externalId, receiptId: "(dry run)", parseStatus: "(dry run)" });
    }
    return summary;
  }
  if (!client) throw new Error("upload needs a FoodFlow client unless dryRun is set");

  try {
    const identity = await client.preflight();
    log(`FoodFlow: ${identity.clientName} -> household ${identity.householdName ?? identity.householdId}`);
  } catch (err) {
    summary.aborted = (err as Error).message;
    return summary;
  }

  for (const record of pending) {
    try {
      const result = await client.uploadReceipt(record);
      archive.recordUpload(record.externalId, {
        uploadedAt: new Date().toISOString(),
        captureSource: record.captureSource,
        receiptId: result.receiptId,
        duplicate: result.duplicate,
      });
      if (result.duplicate) {
        summary.duplicates.push(record.externalId);
      } else {
        summary.uploaded.push({ externalId: record.externalId, receiptId: result.receiptId, parseStatus: result.parseStatus });
        if (result.probableDuplicateOf) {
          summary.probableDuplicates.push({
            externalId: record.externalId,
            receiptId: result.receiptId,
            of: result.probableDuplicateOf,
          });
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof FoodFlowError && FATAL.has(err.code)) {
        summary.aborted = message;
        break;
      }
      summary.failed.push({ externalId: record.externalId, error: message });
    }
  }
  return summary;
}
