/**
 * The output contract: what every store adapter must produce and what
 * FoodFlow's structured receipt endpoint accepts. This file and foodflow.ts
 * are the only places that change when FoodFlow's contract changes.
 *
 * The receipt fields mirror FoodFlow's `structuredReceiptSchema`
 * (src/lib/structuredReceipt.ts); the validator below applies the same rules
 * so a record FoodFlow would reject is refused here, before upload.
 */

/** Bumped when FoodFlow's structured receipt schema changes incompatibly. */
export const CONTRACT_VERSION = 1;

export type CaptureSource = "api" | "email" | "pdf";
export const CAPTURE_SOURCES: readonly CaptureSource[] = ["api", "email", "pdf"];

export interface ReceiptItem {
  /** Product name as the store gave it: catalog name when there is one, else the register text. */
  name: string;
  /** Real unit count, or the weight for a weighed item (with `unit`). Defaults to 1 in FoodFlow. */
  quantity?: number;
  unit?: string;
  /** Paid for the whole line, net of discounts. Negative only on an adjustment or voided line. */
  priceCents?: number;
  listPriceCents?: number;
  discountCents?: number;
  dealType?: string;
  /** Coupon, fee, deposit: kept on the receipt for the spend total, never inventoried. */
  isAdjustment?: boolean;
  /** Voided on the receipt. Implies isAdjustment. */
  isVoided?: boolean;
  confidence?: number;
  note?: string;
  /** The store's own item number (UPC/PLU). FoodFlow keys product aliases on it per chain. */
  itemNumber?: string;
}

/** The structured receipt itself: what a store's normalize produces. */
export interface StructuredReceipt {
  items: ReceiptItem[];
  storeName: string;
  /** ISO 8601 instant in UTC ("…Z"). */
  purchasedAt: string;
  /** Printed grand total, tax included. */
  totalCents?: number;
  taxCents?: number;
  ebtCents?: number;
  /** The printed receipt text, kept by FoodFlow for audit. */
  sourceText?: string;
}

/** One line of normalized JSONL: a structured receipt plus its envelope. */
export interface ReceiptRecord extends StructuredReceipt {
  contractVersion: number;
  /** The store, e.g. "publix". With externalId, FoodFlow's dedupe key per household. */
  externalSource: string;
  /** The store's receipt ID. */
  externalId: string;
  /** Which household member's account this came from. */
  accountLabel: string;
  capturedAt: string;
  captureSource: CaptureSource;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Problems that would make FoodFlow reject or misread the record. Empty means uploadable. */
export function validateRecord(record: ReceiptRecord): string[] {
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(msg);

  if (record.contractVersion !== CONTRACT_VERSION) {
    bad(`contractVersion ${record.contractVersion} is not the version this core speaks (${CONTRACT_VERSION})`);
  }
  if (!record.externalSource || record.externalSource.length > 128) bad("externalSource must be 1-128 characters");
  if (!record.externalId || record.externalId.length > 256) bad("externalId must be 1-256 characters");
  if (!record.accountLabel) bad("accountLabel is required");
  if (!CAPTURE_SOURCES.includes(record.captureSource)) bad(`captureSource "${record.captureSource}" is not known`);
  if (!ISO_UTC.test(record.capturedAt ?? "")) bad("capturedAt must be an ISO 8601 UTC instant");
  if (!record.storeName?.trim()) bad("storeName is required");
  if (!ISO_UTC.test(record.purchasedAt ?? "") || Number.isNaN(Date.parse(record.purchasedAt))) {
    bad("purchasedAt must be an ISO 8601 UTC instant");
  }
  if (record.totalCents !== undefined && !isNonNegInt(record.totalCents)) bad("totalCents must be a non-negative integer");
  if (record.taxCents !== undefined && !isNonNegInt(record.taxCents)) bad("taxCents must be a non-negative integer");
  if (record.ebtCents !== undefined && !isNonNegInt(record.ebtCents)) bad("ebtCents must be a non-negative integer");

  if (!Array.isArray(record.items) || record.items.length === 0) {
    bad("items must have at least one line");
    return problems;
  }
  record.items.forEach((item, i) => {
    const at = `items[${i}]`;
    if (typeof item.name !== "string" || !item.name.trim()) bad(`${at}.name is required`);
    if (item.quantity !== undefined && !(typeof item.quantity === "number" && item.quantity > 0)) {
      bad(`${at}.quantity must be positive`);
    }
    if (item.priceCents !== undefined && !isInt(item.priceCents)) bad(`${at}.priceCents must be an integer`);
    if (!item.isAdjustment && !item.isVoided && (item.priceCents ?? 0) < 0) {
      bad(`${at}.priceCents is negative on a line that is neither an adjustment nor voided`);
    }
    if (item.listPriceCents !== undefined && !isNonNegInt(item.listPriceCents)) {
      bad(`${at}.listPriceCents must be a non-negative integer`);
    }
    if (item.discountCents !== undefined && !isNonNegInt(item.discountCents)) {
      bad(`${at}.discountCents must be a non-negative integer`);
    }
    if (item.confidence !== undefined && !(item.confidence >= 0 && item.confidence <= 1)) {
      bad(`${at}.confidence must be between 0 and 1`);
    }
  });
  return problems;
}

/**
 * FoodFlow's own check: line prices plus tax against the printed total. A
 * mismatch does not block upload (FoodFlow stores the receipt as
 * needs_review); it is reported so a drifting parser is noticed.
 */
export function reconcile(receipt: StructuredReceipt): { differenceCents: number | null } {
  if (receipt.totalCents === undefined) return { differenceCents: null };
  const computed = receipt.items.reduce((sum, item) => sum + (item.priceCents ?? 0), 0) + (receipt.taxCents ?? 0);
  return { differenceCents: computed - receipt.totalCents };
}

/** Request body for FoodFlow: the receipt and its identity, without the adapter-side envelope. */
export function toUploadBody(record: ReceiptRecord): StructuredReceipt & { externalSource: string; externalId: string } {
  const { contractVersion: _v, accountLabel: _a, capturedAt: _c, captureSource: _s, ...body } = record;
  return body;
}
