import type { ReceiptItem } from "../../../core/contract.ts";
import { toCents } from "../../../shared/money.ts";
import type { WallTime } from "../../../shared/time.ts";
import { findReceiptId } from "./ids.ts";

/**
 * Parser for Publix's printed receipt text: the fixed-width block inside an
 * e-receipt email, and the `ReceiptText` field of the API's detail payload.
 *
 * Two generations of the format are in circulation:
 *
 *   classic                                   newer
 *   "  GREEK YOGURT           6.00   F"       "Waffle Mix Buttermilk   F     6.59"
 *   "     You Saved        0.21"              " You saved: $6.59"
 *   "     Promotion       -6.00   F"          (the free item prints 0.00)
 *   "  PASTA SAUCE "                          "Bananas                 F"
 *   "  1 @   2 FOR   5.00   2.50   F"         " $0.65/lb x 1.82 lb           1.18"
 *   "  0.48 lb @  2.49/ lb  1.20   F"
 *   "    Order Total       23.48"             "      Subtotal               19.45"
 *   "      Sales Tax        0.38"             "       Sales Tax 7.5% - T     0.97"
 *   "    Grand Total       23.86"             "  Total                      20.42"
 *   "      Receipt ID: 9999 A1B 100 200"      "            9998 X9X 111 222"
 *   "01/15/2020 16:38 S9999  R110 …"          "           07/04/2020 04:09PM"
 *
 * Tax/benefit letters (t T M L F P H) sit after the amount on classic
 * receipts and before it on newer ones. Lines are matched by shape, never by
 * column position, so the same code also reads text whose spacing was
 * collapsed by an email client or a forward.
 */

export interface ParsedReceiptText {
  receiptId: string | null;
  /** Plaza/facility name from the header, when the text includes the header. */
  storeName: string | null;
  storeNumber: string | null;
  purchasedLocal: WallTime | null;
  totalCents: number | null;
  taxCents: number | null;
  items: ReceiptItem[];
}

const AMT = String.raw`-?\$?\d[\d,]*\.\d{2}`;
const FLAGS = String.raw`((?:\s+[tTMLFPH]){0,2})`;
const re = (source: string, flags = "i") => new RegExp(source, flags);

const ITEM = re(String.raw`^(.+?)\s+(${AMT})${FLAGS}\s*$`, "");
const YOU_SAVED = re(String.raw`^you saved:?\s*(${AMT})`);
const PROMOTION = re(String.raw`^promotion\s+(${AMT})`);
// "0.48 lb @ 2.49/ lb   1.20 F"
const WEIGHED_AT = re(String.raw`^(\d+(?:\.\d+)?)\s*lb\s*@\s*-?\$?(\d+\.\d{2})\s*/\s*lb\s+(${AMT})${FLAGS}\s*$`);
// "$0.65/lb x 1.82 lb   1.18"
const WEIGHED_X = re(String.raw`^\$?(\d+\.\d{2})\s*/\s*lb\s*x\s*(\d+(?:\.\d+)?)\s*lb\s+(${AMT})${FLAGS}\s*$`);
// "1 @ 2 FOR 5.00   2.50 F" and "1 @ 2 for $13.00   6.50"
const MULTIBUY = re(String.raw`^(\d+)\s*@\s*(\d+)\s*for\s+(${AMT})\s+(${AMT})${FLAGS}\s*$`);
// "3 @ 1.05   3.15 F"
const QTY_AT = re(String.raw`^(\d+)\s*@\s*\$?(\d+\.\d{2})\s+(${AMT})${FLAGS}\s*$`);

const SUBTOTAL_LABEL = /^(order total|sub ?total)$/i;
const TOTAL_LABEL = /^(grand total|total)$/i;
const SUMMARY_LABEL = /^(order total|sub ?total|grand total|total|total tax|sales tax\b.*)$/i;
const TRAILING_FLAG = /\s+([tTMLFPH]{1,2})$/;
const DATE = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i;
const PHONE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;
const STREET_ADDRESS = /^\d+\s+[A-Za-z]/;
// Register chatter printed between items: not a product, not a price.
const NOISE = /^(supervisor\s*#?\s*\d+|age bypassed|cashier confirmed\b.*|customer id accepted)$/i;

interface Working extends ReceiptItem {
  name: string;
  priceCents?: number;
  /** "You Saved": already reflected in the printed price. */
  savedCents: number;
  /** "Promotion" lines netted into the price. */
  promoCents: number;
  fromVoidMarker: boolean;
  /** Under a "Refunded Item" marker: goods handed back, on a receipt of their own. */
  refunded: boolean;
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Split a trailing tax/benefit letter off a newer-generation name ("Bananas   F"). */
function stripFlag(name: string): string {
  const stripped = name.replace(TRAILING_FLAG, "");
  return stripped.trim() ? stripped : name;
}

export function parseReceiptText(text: string): ParsedReceiptText {
  const rows = text.split(/\r?\n/).map((row) => row.trim());

  // The itemized block starts after the header (store manager / phone line,
  // when the text carries a header) and ends at the first summary row.
  let end = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]?.match(ITEM);
    if (m?.[1] && (SUBTOTAL_LABEL.test(cleanName(m[1])) || TOTAL_LABEL.test(cleanName(m[1])))) {
      end = i;
      break;
    }
  }
  let start = 0;
  for (let i = 0; i < end; i++) {
    const row = rows[i] ?? "";
    if (/store manager/i.test(row) || (PHONE.test(row) && !ITEM.test(row))) start = i + 1;
  }

  const items: Working[] = [];
  let pendingName: string | null = null;
  let voidNext = false;
  let refundNext = false;
  const isDetailRow = (row: string) =>
    WEIGHED_AT.test(row) || WEIGHED_X.test(row) || MULTIBUY.test(row) || QTY_AT.test(row);

  const unresolved = (name: string) => {
    items.push({
      name,
      confidence: 0.35,
      note: "name printed with no price line",
      savedCents: 0,
      promoCents: 0,
      fromVoidMarker: false,
      refunded: false,
    });
  };
  const add = (item: Omit<Working, "savedCents" | "promoCents" | "fromVoidMarker" | "refunded">) => {
    items.push({ ...item, savedCents: 0, promoCents: 0, fromVoidMarker: voidNext, refunded: refundNext });
    voidNext = false;
    refundNext = false;
    pendingName = null;
  };

  for (let i = start; i < end; i++) {
    const row = rows[i] ?? "";
    if (!row) continue;
    // Banner rules and "LABEL: value" header rows that precede the items on
    // some receipts (recall transactions, a header inside the text block).
    if (/^[*\-\s]{5,}$/.test(row)) continue;
    if (items.length === 0 && (/^recall transaction$/i.test(row) || /^[a-z][a-z \-#]*:\s+\S/i.test(row))) continue;

    if (NOISE.test(row)) continue;

    if (/^voided items?$/i.test(row)) {
      voidNext = true;
      continue;
    }
    if (/^refunded items?$/i.test(row)) {
      refundNext = true;
      continue;
    }

    const last = items[items.length - 1];
    const saved = row.match(YOU_SAVED);
    if (saved) {
      if (last) last.savedCents += Math.abs(toCents(saved[1]) ?? 0);
      continue;
    }
    const promo = row.match(PROMOTION);
    if (promo) {
      const cents = toCents(promo[1]) ?? 0;
      if (last && last.priceCents !== undefined) {
        last.priceCents += cents;
        last.promoCents -= cents;
      }
      continue;
    }

    const weighedAt = row.match(WEIGHED_AT);
    const weighedX = weighedAt ? null : row.match(WEIGHED_X);
    if (weighedAt || weighedX) {
      const quantity = parseFloat((weighedAt ? weighedAt[1] : weighedX?.[2]) as string);
      const perLb = (weighedAt ? weighedAt[2] : weighedX?.[1]) as string;
      const amount = (weighedAt ? weighedAt[3] : weighedX?.[3]) as string;
      add({
        name: pendingName ?? "Weighed item",
        quantity: quantity > 0 ? quantity : 1,
        unit: "lb",
        priceCents: toCents(amount) ?? 0,
        confidence: pendingName ? 0.8 : 0.35,
        note: `weighed: ${quantity} lb @ ${perLb}/lb`,
      });
      continue;
    }

    const multibuy = row.match(MULTIBUY);
    if (multibuy && pendingName) {
      add({
        name: pendingName,
        quantity: Math.max(1, Number(multibuy[1])),
        priceCents: toCents(multibuy[4]) ?? 0,
        dealType: "multibuy",
        confidence: 0.8,
        note: `${multibuy[1]} @ ${multibuy[2]} for ${multibuy[3]}`,
      });
      continue;
    }
    const qtyAt = row.match(QTY_AT);
    if (qtyAt && pendingName) {
      add({
        name: pendingName,
        quantity: Math.max(1, Number(qtyAt[1])),
        priceCents: toCents(qtyAt[3]) ?? 0,
        confidence: 0.8,
        note: `${qtyAt[1]} @ ${qtyAt[2]}`,
      });
      continue;
    }

    // A name that happens to end in a decimal ("DM PPLE CR 15.25") reads like
    // an item line; the quantity/weight row under it says it is only a name.
    const nextRow = rows.slice(i + 1, end).find((r) => r) ?? "";
    const item = isDetailRow(nextRow) ? null : row.match(ITEM);
    if (item?.[1] && /[A-Za-z]/.test(item[1])) {
      if (pendingName) unresolved(pendingName);
      pendingName = null;
      const flagsAfterAmount = Boolean(item[3]?.trim());
      const name = cleanName(flagsAfterAmount ? item[1] : stripFlag(item[1]));
      add({ name, priceCents: toCents(item[2]) ?? 0, confidence: 0.8 });
      continue;
    }

    if (/[A-Za-z]/.test(row)) {
      if (pendingName) unresolved(pendingName);
      pendingName = cleanName(stripFlag(row));
    }
  }
  if (pendingName) unresolved(pendingName);

  return {
    receiptId: findReceiptId(text),
    ...header(rows, start),
    purchasedLocal: purchaseTime(rows, end),
    ...totals(rows, end),
    items: finish(items),
  };
}

/** Settle discounts, coupons and voids once every line's promotions are known. */
function finish(items: Working[]): ReceiptItem[] {
  // A void prints as a negative re-ring of an earlier line. Pair it with that
  // line so neither becomes inventory; the two prices still cancel in the sum.
  const voidedOriginals = new Set<Working>();
  for (let i = 0; i < items.length; i++) {
    const line = items[i] as Working;
    if (!line.fromVoidMarker) continue;
    for (let j = i - 1; j >= 0; j--) {
      const earlier = items[j] as Working;
      if (
        !earlier.fromVoidMarker &&
        !voidedOriginals.has(earlier) &&
        earlier.name === line.name &&
        (earlier.priceCents ?? 0) === -(line.priceCents ?? 0)
      ) {
        voidedOriginals.add(earlier);
        break;
      }
    }
  }

  return items.map((line) => {
    const { savedCents, promoCents, fromVoidMarker, refunded, ...item } = line;
    const out: ReceiptItem = item;
    if (refunded) {
      out.isVoided = true;
      out.note = "refunded";
      return out;
    }
    if (fromVoidMarker) {
      out.isVoided = true;
      out.note = "voided at the register";
      return out;
    }
    if (voidedOriginals.has(line)) {
      out.isVoided = true;
      out.note = "voided later on the same receipt";
      return out;
    }
    if (out.priceCents !== undefined && out.priceCents < 0) {
      out.isAdjustment = true;
      out.dealType = "coupon";
      return out;
    }
    const discount = savedCents + promoCents;
    if (discount > 0 && out.priceCents !== undefined) {
      out.discountCents = discount;
      out.listPriceCents = out.priceCents + discount;
      out.dealType = out.dealType ?? (out.priceCents === 0 ? "bogo" : promoCents > 0 ? "promotion" : "sale");
    }
    return out;
  });
}

function header(rows: string[], start: number): { storeName: string | null; storeNumber: string | null } {
  let storeName: string | null = null;
  for (let i = 1; i < start; i++) {
    if (!STREET_ADDRESS.test(rows[i] ?? "")) continue;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = rows[j] ?? "";
      if (candidate && /[A-Za-z]/.test(candidate) && !/publix super markets|thank you|receipt/i.test(candidate)) {
        storeName = cleanName(candidate);
        break;
      }
    }
    break;
  }
  const text = rows.join("\n");
  const number = text.match(/\d{2}:\d{2}\s+S(\d{3,5})\b/) ?? text.match(/\bstore\s+#?(\d{3,5})\b/i);
  return { storeName, storeNumber: number?.[1] ? String(Number(number[1])) : null };
}

function purchaseTime(rows: string[], end: number): WallTime | null {
  // The stamp prints below the totals; fall back to the whole text for
  // layouts that put it in the header.
  const m = rows.slice(end).join("\n").match(DATE) ?? rows.join("\n").match(DATE);
  if (!m) return null;
  let hour = Number(m[4]);
  const meridiem = m[6]?.toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return { year: Number(m[3]), month: Number(m[1]), day: Number(m[2]), hour, minute: Number(m[5]) };
}

function totals(rows: string[], end: number): { totalCents: number | null; taxCents: number | null } {
  let subtotal: number | null = null;
  let grand: number | null = null;
  let plainTotal: number | null = null;
  let totalTax: number | null = null;
  let salesTax: number | null = null;
  for (const row of rows.slice(end)) {
    const m = row.match(ITEM);
    if (!m?.[1]) continue;
    const label = cleanName(m[1]);
    if (!SUMMARY_LABEL.test(label)) continue;
    const cents = toCents(m[2]) ?? 0;
    if (SUBTOTAL_LABEL.test(label)) subtotal ??= cents;
    else if (/^grand total$/i.test(label)) grand ??= cents;
    else if (/^total$/i.test(label)) plainTotal ??= cents;
    else if (/^total tax$/i.test(label)) totalTax ??= cents;
    // One "Sales Tax" row prints per rate.
    else if (/^sales tax/i.test(label)) salesTax = (salesTax ?? 0) + cents;
  }
  const taxCents = totalTax ?? salesTax;
  const totalCents = grand ?? plainTotal ?? (subtotal === null ? null : subtotal + (taxCents ?? 0));
  return { totalCents, taxCents };
}
