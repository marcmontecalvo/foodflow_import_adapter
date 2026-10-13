import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CaptureSource, ReceiptRecord } from "./contract.ts";
import type { RawReceipt } from "./adapter.ts";

/**
 * Everything the importer keeps on disk for one store account:
 *
 *   <data>/raw/<store>/<account>/<receiptId>.<source>.json   raw archive
 *   <data>/normalized/<store>/<account>.jsonl                normalized output
 *   <data>/state/<store>/<account>/uploaded.json             upload ledger
 *   <data>/accounts/<store>/<account>/                       sessions (private)
 *   <data>/inbox/<store>/<account>/                          drop folder for .eml files
 *
 * The raw archive is the durable copy. Store history windows are short and
 * tokens expire, so a raw file is often the only copy of a receipt; it is
 * written before anything is interpreted and never rewritten by normalize.
 */

export function dataDir(): string {
  return resolve(process.env.FFIMPORT_DATA_DIR || "data");
}

const LABEL = /^[a-z0-9][a-z0-9_-]*$/;

export interface UploadEntry {
  uploadedAt: string;
  captureSource: CaptureSource;
  /** FoodFlow's receipt id. */
  receiptId: string;
  /** True when FoodFlow already had this receipt and created nothing. */
  duplicate: boolean;
}

function writeAtomic(path: string, content: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, mode === undefined ? {} : { mode });
  renameSync(tmp, path);
}

export function safeFileId(externalId: string): string {
  return externalId.replace(/[^A-Za-z0-9._-]/g, "_") || "receipt";
}

export class AccountArchive {
  readonly store: string;
  readonly accountLabel: string;
  private readonly root: string;

  constructor(store: string, accountLabel: string, root: string = dataDir()) {
    if (!LABEL.test(accountLabel)) {
      throw new Error(`Account label "${accountLabel}" must be lowercase letters, digits, "-" or "_" (e.g. marc).`);
    }
    this.store = store;
    this.accountLabel = accountLabel;
    this.root = root;
  }

  get rawDir(): string {
    return join(this.root, "raw", this.store, this.accountLabel);
  }
  get accountDir(): string {
    return join(this.root, "accounts", this.store, this.accountLabel);
  }
  get inboxDir(): string {
    return join(this.root, "inbox", this.store, this.accountLabel);
  }
  get normalizedPath(): string {
    return join(this.root, "normalized", this.store, `${this.accountLabel}.jsonl`);
  }
  private get ledgerPath(): string {
    return join(this.root, "state", this.store, this.accountLabel, "uploaded.json");
  }

  private rawPath(externalId: string, source: CaptureSource): string {
    return join(this.rawDir, `${safeFileId(externalId)}.${source}.json`);
  }

  hasRaw(externalId: string, source: CaptureSource): boolean {
    return existsSync(this.rawPath(externalId, source));
  }

  writeRaw(raw: RawReceipt): void {
    mkdirSync(this.rawDir, { recursive: true });
    writeAtomic(this.rawPath(raw.externalId, raw.captureSource), JSON.stringify(raw, null, 2) + "\n");
  }

  /** Every archived receipt, optionally for one source. Unreadable files are skipped, not fatal. */
  listRaw(source?: CaptureSource): RawReceipt[] {
    if (!existsSync(this.rawDir)) return [];
    const suffix = source ? `.${source}.json` : ".json";
    const raws: RawReceipt[] = [];
    for (const name of readdirSync(this.rawDir).sort()) {
      if (!name.endsWith(suffix)) continue;
      try {
        raws.push(JSON.parse(readFileSync(join(this.rawDir, name), "utf8")) as RawReceipt);
      } catch {
        // A truncated file from an interrupted run: capture will replace it.
      }
    }
    return raws;
  }

  writeNormalized(records: ReceiptRecord[]): void {
    mkdirSync(join(this.root, "normalized", this.store), { recursive: true });
    writeAtomic(this.normalizedPath, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  }

  readLedger(): Record<string, UploadEntry> {
    if (!existsSync(this.ledgerPath)) return {};
    return JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Record<string, UploadEntry>;
  }

  recordUpload(externalId: string, entry: UploadEntry): void {
    const ledger = this.readLedger();
    ledger[externalId] = entry;
    mkdirSync(join(this.root, "state", this.store, this.accountLabel), { recursive: true });
    writeAtomic(this.ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  }
}
