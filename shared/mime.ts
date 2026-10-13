/**
 * Minimal RFC 5322 / MIME reader: enough to pull the HTML and text bodies out
 * of a saved .eml, and to find receipts that were forwarded as attachments.
 * No store knowledge lives here.
 */

export interface MimeMessage {
  headers: Map<string, string>;
  /** Decoded text/html bodies of this message, not of any attached message. */
  html: string[];
  /** Decoded text/plain bodies of this message. */
  text: string[];
  /** Emails attached to this one (message/rfc822 parts or *.eml files). */
  attached: MimeMessage[];
}

interface Part {
  headers: Map<string, string>;
  body: string; // latin1: one char per byte
}

function splitHeaders(raw: string): Part {
  const m = raw.match(/\r?\n\r?\n/);
  const headerBlock = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice((m.index ?? 0) + m[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(idx + 1).trim());
  }
  return { headers, body };
}

function param(headerValue: string, name: string): string | null {
  const m = headerValue.match(new RegExp(`(?:^|;)\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function decodeBytes(part: Part): Buffer {
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").toLowerCase();
  if (encoding === "base64") return Buffer.from(part.body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (encoding === "quoted-printable") {
    const qp = part.body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(qp, "latin1");
  }
  return Buffer.from(part.body, "latin1");
}

function decodeText(part: Part): string {
  const charset = param(part.headers.get("content-type") ?? "", "charset") ?? "utf-8";
  const bytes = decodeBytes(part);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function walk(part: Part, into: MimeMessage, depth: number): void {
  const contentType = part.headers.get("content-type") ?? "text/plain";
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();

  if (type.startsWith("multipart/")) {
    const boundary = param(contentType, "boundary");
    if (!boundary) return;
    const segments = part.body.split(new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    // First segment is the preamble; anything after the closing delimiter is epilogue.
    for (const segment of segments.slice(1)) {
      if (segment.trim()) walk(splitHeaders(segment), into, depth);
    }
    return;
  }

  const filename =
    param(part.headers.get("content-disposition") ?? "", "filename") ?? param(contentType, "name") ?? "";
  if (type === "message/rfc822" || filename.toLowerCase().endsWith(".eml")) {
    if (depth < 5) into.attached.push(parseMessage(decodeBytes(part).toString("latin1"), depth + 1));
    return;
  }
  if (type === "text/html") into.html.push(decodeText(part));
  else if (type === "text/plain") into.text.push(decodeText(part));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMessage(latin1: string, depth: number): MimeMessage {
  const top = splitHeaders(latin1);
  const message: MimeMessage = { headers: top.headers, html: [], text: [], attached: [] };
  walk(top, message, depth);
  return message;
}

export function parseEml(raw: Buffer | string): MimeMessage {
  // A string is assumed to be what `readFile(path, "utf8")` returned.
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  return parseMessage(bytes.toString("latin1"), 0);
}

/** This message and every email attached to it, depth first. */
export function* allMessages(message: MimeMessage): Generator<MimeMessage> {
  yield message;
  for (const child of message.attached) yield* allMessages(child);
}
