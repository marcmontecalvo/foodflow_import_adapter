/**
 * Browser DevTools "Copy as cURL" import. Store sites sit behind interactive
 * sign-in with 2FA, so the session is captured from a request the user's own
 * browser already made rather than by automating the login.
 */

export interface ParsedCurl {
  url: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  cookies: Record<string, string>;
}

/** Shell-ish tokenizer covering bash ('…', "…", $'…') and cmd.exe (^ continuations) exports. */
function tokenize(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ").replace(/`\r?\n/g, " ");
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let i = 0;
  const push = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      push();
      i++;
    } else if (ch === "'" || (ch === "$" && text[i + 1] === "'")) {
      const ansi = ch === "$";
      i += ansi ? 2 : 1;
      started = true;
      while (i < text.length && text[i] !== "'") {
        if (ansi && text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1] as string;
          current += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
        } else {
          current += text[i];
          i++;
        }
      }
      i++;
    } else if (ch === '"') {
      i++;
      started = true;
      while (i < text.length && text[i] !== '"') {
        if ((text[i] === "\\" || text[i] === "^") && i + 1 < text.length) i++;
        current += text[i];
        i++;
      }
      i++;
    } else if ((ch === "\\" || ch === "^") && i + 1 < text.length) {
      current += text[i + 1];
      started = true;
      i += 2;
    } else {
      current += ch;
      started = true;
      i++;
    }
  }
  push();
  return tokens;
}

export function parseCookieHeader(value: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of value.split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return cookies;
}

export function parseCurl(input: string): ParsedCurl {
  const tokens = tokenize(input.trim());
  if (tokens[0]?.toLowerCase().replace(/\.exe$/, "") !== "curl") {
    throw new Error(
      'That is not a cURL command. In DevTools: Network tab, right-click the request, Copy, "Copy as cURL".'
    );
  }
  const headers: Record<string, string> = {};
  let cookieHeader = "";
  let url = "";
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const next = tokens[i + 1];
    if ((token === "-H" || token === "--header") && next !== undefined) {
      const idx = next.indexOf(":");
      if (idx > 0) headers[next.slice(0, idx).trim().toLowerCase()] = next.slice(idx + 1).trim();
      i++;
    } else if ((token === "-b" || token === "--cookie") && next !== undefined) {
      cookieHeader = next;
      i++;
    } else if (token === "--url" && next !== undefined) {
      url = next;
      i++;
    } else if (/^https?:\/\//i.test(token) && !url) {
      url = token;
    }
  }
  return { url, headers, cookies: parseCookieHeader(cookieHeader || headers["cookie"] || "") };
}
