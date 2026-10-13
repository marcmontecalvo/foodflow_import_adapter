import type { NormalizeContext, NormalizeResult } from "../../../core/adapter.ts";
import { htmlToText } from "../../../shared/html.ts";
import { wallTimeToIso } from "../../../shared/time.ts";
import { storeDisplayName } from "./ids.ts";
import { parseReceiptText } from "./receiptText.ts";

/** The payload email/capture.ts archives: one receipt email's bodies and identifying headers. */
export interface EmailPayload {
  html: string | null;
  text: string | null;
  messageId: string | null;
  from: string | null;
  subject: string | null;
  date: string | null;
  /** The .eml this came out of (the outer file, for a receipt forwarded as an attachment). */
  file: string | null;
}

// Everything from the marketing footer on is not receipt text.
const FOOTER =
  /please do not reply to this email|this email was sent to|unsubscribe from all|view this email in your browser|update your receipt preferences/i;

/** The printed receipt as text, header included, from whichever body the email carries. */
export function emailReceiptText(payload: Pick<EmailPayload, "html" | "text">): string {
  const body = payload.html ? htmlToText(payload.html) : (payload.text ?? "");
  const footer = body.search(FOOTER);
  return (footer >= 0 ? body.slice(0, footer) : body).replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeEmail(payload: EmailPayload, ctx: NormalizeContext): NormalizeResult {
  const sourceText = emailReceiptText(payload);
  const parsed = parseReceiptText(sourceText);
  if (parsed.items.length === 0) return { status: "skip", reason: "no line items found in the email" };

  // The printed stamp is the purchase time; the email's own Date header is
  // only when Publix got around to sending it.
  const emailDate = payload.date ? new Date(payload.date) : null;
  const purchasedAt = parsed.purchasedLocal
    ? wallTimeToIso(parsed.purchasedLocal, ctx.timeZone)
    : emailDate && !Number.isNaN(emailDate.getTime())
      ? emailDate.toISOString()
      : null;
  if (!purchasedAt) return { status: "skip", reason: "no purchase time on the receipt or the email" };

  return {
    status: "ok",
    receipt: {
      storeName: storeDisplayName(parsed.storeName),
      purchasedAt,
      ...(parsed.totalCents !== null && parsed.totalCents >= 0 ? { totalCents: parsed.totalCents } : {}),
      ...(parsed.taxCents !== null && parsed.taxCents >= 0 ? { taxCents: parsed.taxCents } : {}),
      sourceText,
      items: parsed.items,
    },
  };
}
