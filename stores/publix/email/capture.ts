import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CaptureContext, RawReceipt } from "../../../core/adapter.ts";
import { allMessages, parseEml, type MimeMessage } from "../../../shared/mime.ts";
import { emailReceiptText, type EmailPayload } from "../normalize/fromEmail.ts";
import { findReceiptId } from "../normalize/ids.ts";
import { parseReceiptText } from "../normalize/receiptText.ts";

/**
 * Capture from Publix e-receipt emails saved as .eml files: the account's
 * inbox folder by default, or the files/folders passed on the command line.
 *
 * A receipt is recognized by content, not by sender, so a receipt the user
 * forwarded to themselves still counts: inline, or as an attached email. One
 * .eml can therefore yield several receipts.
 */

function emlFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.toLowerCase().endsWith(".eml") ? [path] : [];
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => emlFiles(join(path, entry.name)));
}

function toPayload(message: MimeMessage, file: string): EmailPayload {
  return {
    html: message.html.length ? message.html.join("\n") : null,
    text: message.text.length ? message.text.join("\n") : null,
    messageId: message.headers.get("message-id") ?? null,
    from: message.headers.get("from") ?? null,
    subject: message.headers.get("subject") ?? null,
    date: message.headers.get("date") ?? null,
    file,
  };
}

/** Receipt ID when this email is a Publix receipt: mentions Publix, prints a receipt ID and a total. */
export function receiptIdOf(payload: EmailPayload): string | null {
  const text = emailReceiptText(payload);
  if (!/publix/i.test(`${payload.from ?? ""}\n${payload.subject ?? ""}\n${text}`)) return null;
  const id = findReceiptId(text);
  return id && parseReceiptText(text).totalCents !== null ? id : null;
}

export async function* captureEmail(ctx: CaptureContext): AsyncGenerator<RawReceipt> {
  const paths = ctx.options.paths?.length ? ctx.options.paths : [ctx.inboxDir];
  const files = paths.flatMap(emlFiles);
  let receipts = 0;
  const seen = new Set<string>();
  for (const file of files) {
    let message: MimeMessage;
    try {
      message = parseEml(readFileSync(file));
    } catch (err) {
      ctx.log(`email: could not read ${file}: ${(err as Error).message}`);
      continue;
    }
    for (const candidate of allMessages(message)) {
      const payload = toPayload(candidate, file);
      const externalId = receiptIdOf(payload);
      if (!externalId || seen.has(externalId)) continue;
      seen.add(externalId);
      receipts++;
      yield { externalId, captureSource: "email", capturedAt: new Date().toISOString(), payload };
    }
  }
  ctx.log(`email: ${files.length} .eml file(s) read from ${paths.join(", ")}, ${receipts} Publix receipt(s) found`);
}
