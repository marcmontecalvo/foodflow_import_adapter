import type { NormalizeContext, NormalizeResult } from "../../../core/adapter.ts";
import type { ReceiptItem } from "../../../core/contract.ts";
import { decodeEntities } from "../../../shared/html.ts";
import { toCents } from "../../../shared/money.ts";
import { parseLocalIso, wallTimeToIso } from "../../../shared/time.ts";
import { storeDisplayName } from "./ids.ts";
import { parseReceiptText } from "./receiptText.ts";

/**
 * Normalize one purchase from the purchase-history API.
 *
 * Money on a line item, as the API reports it:
 *   ItemAmount    what the receipt prints on the line
 *   NetAmount     what the line contributed to the total (0 for the free half of a BOGO)
 *   SavingAmount  saving against the regular price; for a sale price this is
 *                 already inside ItemAmount, so it is context, never subtracted
 */

/** The payload api/capture.ts archives: the list row and the detail response, both verbatim. */
export interface ApiPayload {
  list: Record<string, unknown>;
  detail: Record<string, unknown>;
}

type Row = Record<string, unknown>;

const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const text = (value: unknown): string => decodeEntities(String(value ?? "")).replace(/\s+/g, " ").trim();
const cents = (value: unknown): number => toCents(typeof value === "string" ? value : Number(value ?? 0)) ?? 0;

/** "00000000004011" -> "4011". ItemCode and UPC are zero-padded differently between fields. */
export function bareCode(code: unknown): string {
  const digits = String(code ?? "").replace(/\D/g, "");
  return digits.replace(/^0+/, "") || "";
}

/** ReceiptText arrives with newlines escaped as a literal "\n" and/or as "&#10;". */
export function decodeReceiptText(value: unknown): string {
  return decodeEntities(String(value ?? "").replace(/\\n/g, "\n"));
}

/**
 * Publix lists a purchase within minutes but publishes its catalog detail a
 * day or two later. Until then every line reads "Normal Sale" with no product
 * name. Such a receipt is not uploaded; a later capture replaces it.
 */
export function isUnpublished(detail: Row): boolean {
  const lines = rows(detail.ReceiptLineItems);
  if (lines.length === 0) return false;
  return !rows(detail.Products).some((p) => text(p.ItemName) || text(p.ItemDescription));
}

function productName(product: Row): string {
  const name = text(product.ItemName) || text(product.ItemDescription);
  const size = text(product.SizeDescription);
  return size && !name.toLowerCase().includes(size.toLowerCase()) ? `${name}, ${size}` : name;
}

export function normalizeApi(payload: ApiPayload, ctx: NormalizeContext): NormalizeResult {
  // The list row has the clean identifiers; the detail has everything else.
  const merged: Row = { ...payload.list, ...payload.detail };
  const lines = rows(merged.ReceiptLineItems);

  const when = parseLocalIso(merged.TransactionDate ?? payload.list.TransactionDate);
  if (!when) return { status: "skip", reason: "no TransactionDate" };

  const sourceText = decodeReceiptText(merged.ReceiptText);
  const header = {
    storeName: storeDisplayName(text(merged.FacilityName)),
    purchasedAt: wallTimeToIso(when, ctx.timeZone),
    ...(sourceText.trim() ? { sourceText } : {}),
  };
  const grand = merged.GrandTotal ?? merged.Amount;
  const totals = {
    ...(grand != null && cents(grand) >= 0 ? { totalCents: cents(grand) } : {}),
    ...(merged.TaxAmount != null && cents(merged.TaxAmount) >= 0 ? { taxCents: cents(merged.TaxAmount) } : {}),
  };

  if (lines.length === 0) {
    // Seen when the detail carries only the printed text.
    const parsed = sourceText ? parseReceiptText(sourceText) : null;
    if (!parsed || parsed.items.length === 0) return { status: "skip", reason: "detail has no line items yet" };
    return { status: "ok", receipt: { ...header, ...totals, items: parsed.items } };
  }
  if (isUnpublished(merged)) return { status: "skip", reason: "detail not published yet (no product names)" };

  // ItemCode is usually the UPC but sometimes the catalog ItemId; index both.
  const products = new Map<string, Row>();
  for (const product of rows(merged.Products)) {
    for (const key of [bareCode(product.UPC), bareCode(product.ItemId)]) {
      if (key && !products.has(key)) products.set(key, product);
    }
  }

  const ordered = [...lines].sort((a, b) => Number(a.ItemSeqNo ?? 0) - Number(b.ItemSeqNo ?? 0));
  const items = ordered.map((line): ReceiptItem => {
    const code = bareCode(line.ItemCode);
    const product = products.get(code);
    // Canonicalize on the product's UPC so the item number is the same
    // whichever code this particular receipt carried.
    const itemNumber = (product && bareCode(product.UPC)) || code;
    const named = product ? productName(product) : "";
    const printed = cents(line.ItemAmount);
    const paid = line.NetAmount != null ? cents(line.NetAmount) : printed - cents(line.SavingAmount);
    // "Normal Sale" is the type of every ordinary line; anything else
    // ("Vendor Coupon") says what the line is when there is no product.
    const type = text(line.ItemTypeDescription);
    const typeName = type && !/^normal sale$/i.test(type) ? type : "";
    const name = named || typeName || (itemNumber ? `Publix item ${itemNumber}` : "Publix item");
    const base = { name, ...(itemNumber ? { itemNumber } : {}) };

    if (paid < 0 || printed < 0) {
      return { name: named || typeName || "Coupon", priceCents: paid, isAdjustment: true, dealType: "coupon" };
    }
    if (Number(line.IsGiftcardItem ?? 0) > 0) {
      return { name: named || "Gift card", priceCents: paid, isAdjustment: true, dealType: "fee", note: "gift card" };
    }

    const weight = Number(line.ItemWeight ?? 0);
    const count = Number(line.ItemQty ?? 0);
    const item: ReceiptItem = {
      ...base,
      // Weighed items report ItemQty 0 and a weight in pounds.
      ...(count <= 0 && weight > 0
        ? { quantity: weight, unit: "lb" }
        : { quantity: count > 0 ? count : Number(line.MSUQty ?? 0) > 0 ? Number(line.MSUQty) : 1 }),
      priceCents: paid,
      confidence: named ? 0.95 : 0.35,
    };
    if (!named) item.note = "no catalog entry for this line";

    const discount = Math.max(cents(line.SavingAmount), printed - paid, 0);
    if (discount > 0) {
      item.discountCents = discount;
      item.listPriceCents = paid + discount;
      item.dealType = paid === 0 ? "bogo" : printed > paid ? "promotion" : "sale";
    }
    return item;
  });

  return { status: "ok", receipt: { ...header, ...totals, items } };
}
