import type { CaptureContext, RawReceipt } from "../../../core/adapter.ts";
import { HttpError, createHttp } from "../../../shared/http.ts";
import { minutesLeft } from "../../../shared/jwt.ts";
import { isoDate, parseLocalIso, wallTimeToIso } from "../../../shared/time.ts";
import { decodeReceiptText, isUnpublished, type ApiPayload } from "../normalize/fromApi.ts";
import { canonicalReceiptId, findReceiptId } from "../normalize/ids.ts";
import { loadSession, requestHeaders } from "./session.ts";

/**
 * Capture from the purchase-history API the publix.com account page uses:
 *
 *   GET /v1/PurchaseHistory?fromDate=&toDate=&page=&size=    paged list, newest first
 *   GET /v1/PurchaseHistory/detail?transactionKey=<key>      one full receipt
 *
 * The API is undocumented and can change without notice; adapter.json records
 * when it was last verified.
 */

const PAGE_SIZE = 25;

function apiBase(): string {
  return (process.env.PUBLIX_API_BASE || "https://services.publix.com/api").replace(/\/+$/, "");
}

const REIMPORT = (account: string) =>
  `Import a fresh one: copy the PurchaseHistory request from your browser as cURL, then run ` +
  `"ffimport auth publix --account ${account}".`;

/** The list row's own identity. It differs from the detail's printed receipt ID, so it is what incremental runs skip on. */
function listKey(txn: Record<string, unknown>): string {
  return String(txn.ReceiptId ?? txn.TransactionKey ?? "");
}

export async function* captureApi(ctx: CaptureContext): AsyncGenerator<RawReceipt> {
  const { manifest, options, now, log } = ctx;
  const session = loadSession(ctx.accountDir);
  if (!session) throw new Error(`No Publix API session for account "${ctx.accountLabel}". ${REIMPORT(ctx.accountLabel)}`);
  const left = minutesLeft(session.token, now);
  if (left !== null && left <= 0) {
    throw new Error(`The Publix API session expired ${-left} min ago (tokens last about an hour). ${REIMPORT(ctx.accountLabel)}`);
  }

  const http = createHttp({ headers: requestHeaders(session), minIntervalMs: 400 });
  const get = async (path: string, query: Record<string, string | number | undefined>) => {
    try {
      return (await http.getJson(apiBase() + path, query)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw new AuthError(`Publix rejected the session (HTTP ${err.status}). ${REIMPORT(ctx.accountLabel)}`);
      }
      throw err;
    }
  };

  const timeZone = manifest.timeZone ?? "America/New_York";
  const to = options.to ?? isoDate(now);
  const from = options.from ?? isoDate(new Date(now.getTime() - (manifest.retentionDays ?? 180) * 86_400_000));
  const notBefore = now.getTime() - (manifest.detailDelayHours ?? 0) * 3_600_000;

  const known = new Set<string>();
  if (!options.refetch) {
    for (const raw of ctx.archived("api")) known.add(listKey((raw.payload as ApiPayload).list ?? {}));
  }

  let listed = 0;
  let tooRecent = 0;
  let unpublished = 0;
  for (let page = 1; ; page++) {
    const envelope = await get("/v1/PurchaseHistory", { page, size: PAGE_SIZE, fromDate: from, toDate: to });
    const txns = Array.isArray(envelope.CurrentTransactions)
      ? (envelope.CurrentTransactions as Record<string, unknown>[])
      : [];
    for (const txn of txns) {
      listed++;
      const key = listKey(txn);
      const when = parseLocalIso(txn.TransactionDate);
      const label = String(txn.TransactionDate ?? "").slice(0, 10) || key;
      // Detail publishes a day or so after purchase; asking earlier returns a placeholder.
      if (when && Date.parse(wallTimeToIso(when, timeZone)) > notBefore) {
        tooRecent++;
        continue;
      }
      if (key && known.has(key)) continue;
      if (!txn.TransactionKey) {
        log(`api: ${label} has no TransactionKey, skipped`);
        continue;
      }

      let detail: Record<string, unknown>;
      try {
        detail = await get("/v1/PurchaseHistory/detail", { transactionKey: String(txn.TransactionKey) });
      } catch (err) {
        if (err instanceof AuthError) throw err;
        log(`api: detail for ${label} failed: ${(err as Error).message}`);
        continue;
      }
      if (isUnpublished(detail)) {
        unpublished++;
        continue;
      }

      // The printed receipt ID is the one identity every source shares.
      const externalId =
        findReceiptId(decodeReceiptText(detail.ReceiptText)) ||
        canonicalReceiptId(String(detail.ReceiptId ?? "")) ||
        `TXN-${String(txn.TransactionKey).replace(/[^A-Za-z0-9]/g, "")}`;
      const payload: ApiPayload = { list: txn, detail };
      yield { externalId, captureSource: "api", capturedAt: new Date().toISOString(), payload };
    }
    const totalPages = Number(envelope.TotalPages ?? 1);
    if (txns.length === 0 || page >= totalPages) break;
  }

  log(
    `api: ${listed} purchases listed ${from}..${to}` +
      (tooRecent ? `, ${tooRecent} too recent for detail` : "") +
      (unpublished ? `, ${unpublished} with detail not published yet` : "")
  );
}

class AuthError extends Error {}
