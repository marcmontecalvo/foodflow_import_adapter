/**
 * The printed receipt ID, e.g. "9999 A1B 100 200" (or the older all-numeric
 * "5417 9660 5160 3902 038"). The API's detail payload carries the same ID
 * without spaces, so the canonical form drops whitespace and upper-cases:
 * the API capture and the email capture of one purchase then share an ID.
 */
export function canonicalReceiptId(printed: string): string {
  return printed.replace(/\s+/g, "").toUpperCase();
}

const ID_GROUPS = String.raw`\d{4}(?:[ \t]+[0-9A-Za-z]{3,4}){3,4}`;
const LABELLED = new RegExp(String.raw`Receipt ID:[ \t]*(${ID_GROUPS})`, "i");
const BARE = new RegExp(String.raw`^[ \t]*(${ID_GROUPS})[ \t]*$`, "m");

/** Find the receipt ID in printed receipt text: labelled on older receipts, a bare line on newer ones. */
export function findReceiptId(text: string): string | null {
  const m = text.match(LABELLED) ?? text.match(BARE);
  return m?.[1] ? canonicalReceiptId(m[1]) : null;
}

/** "Sample Plaza" -> "Publix Sample Plaza": chain first, as FoodFlow keys aliases on it. */
export function storeDisplayName(facilityName: string | null | undefined): string {
  const name = (facilityName ?? "").replace(/\s+/g, " ").trim();
  if (!name) return "Publix";
  return /^publix\b/i.test(name) ? name : `Publix ${name}`;
}
