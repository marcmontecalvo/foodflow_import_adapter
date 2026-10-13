import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadStore } from "../core/adapter.ts";
import { AccountArchive } from "../core/archive.ts";
import { CONTRACT_VERSION } from "../core/contract.ts";
import { FoodFlowClient } from "../core/foodflow.ts";
import { capture, normalize, upload } from "../core/pipeline.ts";
import { saveSession } from "../stores/publix/api/session.ts";
import { FIXTURES, fakeJwt, fixtureJson, tempDir } from "./helpers.ts";

/** Shortly after the fixture purchases: the 02-01 one is still inside the detail delay. */
const NOW = new Date("2020-02-01T15:00:00Z");

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
};
const listen = (server: Server) =>
  new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

// --- stub Publix purchase-history API ---------------------------------------
const publix = { detailCalls: [] as string[], token: "" };
const publixServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const send = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  if (req.headers.authorization !== `Bearer ${publix.token}` || req.headers.ecmsid !== "1234567") return send(401, {});
  if (url.pathname === "/v1/PurchaseHistory") return send(200, fixtureJson("api-list.json"));
  if (url.pathname === "/v1/PurchaseHistory/detail") {
    const key = url.searchParams.get("transactionKey") ?? "";
    publix.detailCalls.push(key);
    const detail = fixtureJson("api-detail.json");
    if (key === "FIXTURE_KEY_UNPUBLISHED") return send(200, { ...detail, Products: [], ReceiptId: "9999ZZZ000000", ReceiptText: "" });
    return send(200, detail);
  }
  send(404, {});
});

// --- stub FoodFlow -----------------------------------------------------------
const foodflow = { receipts: new Map<string, any>(), posts: 0, contractVersion: CONTRACT_VERSION as number | undefined };
const foodflowServer = createServer(async (req, res) => {
  const send = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  if (req.headers.authorization !== "Bearer ff_test") return send(401, { error: { code: "unauthorized", message: "bad token" } });
  if (req.url === "/api/household/whoami") {
    return send(200, { clientName: "test", householdId: "h1", householdName: "Test", scopes: ["read", "ingest"], receiptContractVersion: foodflow.contractVersion });
  }
  if (req.url === "/api/household/receipts" && req.method === "POST") {
    foodflow.posts++;
    const input = await body(req);
    const key = `${input.externalSource}/${input.externalId}`;
    const existing = foodflow.receipts.get(key);
    if (existing) return send(200, { receipt: existing, duplicate: true, probableDuplicateOf: null });
    const receipt = { id: `r${foodflow.receipts.size + 1}`, externalSource: input.externalSource, externalId: input.externalId, parseStatus: "parsed", items: input.items, sent: input };
    foodflow.receipts.set(key, receipt);
    return send(201, { receipt, duplicate: false, probableDuplicateOf: null, reconciliation: { reconciled: true, differenceCents: 0 } });
  }
  send(404, { error: { code: "not_found", message: "no route" } });
});

let client: FoodFlowClient;
before(async () => {
  process.env.PUBLIX_API_BASE = await listen(publixServer);
  client = new FoodFlowClient({ baseUrl: await listen(foodflowServer), token: "ff_test" });
});
after(() => {
  publixServer.close();
  foodflowServer.close();
});

function account(label: string) {
  const archive = new AccountArchive("publix", label, tempDir());
  publix.token = fakeJwt(30, NOW);
  saveSession(archive.accountDir, { token: publix.token, ecmsId: "1234567", userAgent: null, savedAt: NOW.toISOString() });
  return archive;
}

test("api capture -> normalize -> upload, then a second run changes nothing", async () => {
  const loaded = await loadStore("publix");
  const archive = account("marc");
  publix.detailCalls = [];
  foodflow.receipts.clear();
  foodflow.posts = 0;

  const captured = await capture(loaded, archive, { sources: ["api"], now: NOW });
  assert.deepEqual(captured.sources.api, { captured: 1, alreadyArchived: 0 });
  // The too-recent purchase is never asked for; the unpublished one is asked for but not archived.
  assert.deepEqual(publix.detailCalls.sort(), ["FIXTURE_KEY_1", "FIXTURE_KEY_UNPUBLISHED"]);
  assert.ok(existsSync(join(archive.rawDir, "9999A1B100200.api.json")));

  const normalized = normalize(loaded, archive);
  assert.equal(normalized.records.length, 1);
  assert.deepEqual([normalized.skipped, normalized.invalid, normalized.unreconciled], [[], [], []]);
  const line = JSON.parse(readFileSync(archive.normalizedPath, "utf8").trim());
  assert.deepEqual(
    { v: line.contractVersion, src: line.externalSource, id: line.externalId, account: line.accountLabel, via: line.captureSource },
    { v: CONTRACT_VERSION, src: "publix", id: "9999A1B100200", account: "marc", via: "api" }
  );

  const first = await upload(loaded, archive, normalized.records, client, { now: NOW });
  assert.equal(first.uploaded.length, 1);
  const stored = foodflow.receipts.get("publix/9999A1B100200");
  assert.equal(stored.sent.items[1].itemNumber, "1234500012");
  assert.equal(stored.sent.accountLabel, undefined, "the adapter envelope stays out of the request");

  // Second run: nothing re-fetched except the still-unpublished detail, nothing re-posted.
  publix.detailCalls = [];
  const again = await capture(loaded, archive, { sources: ["api"], now: NOW });
  assert.deepEqual(again.sources.api, { captured: 0, alreadyArchived: 0 });
  assert.deepEqual(publix.detailCalls, ["FIXTURE_KEY_UNPUBLISHED"]);
  const second = await upload(loaded, archive, normalize(loaded, archive).records, client, { now: NOW });
  assert.deepEqual([second.uploaded.length, second.alreadyUploaded, foodflow.posts], [0, 1, 1]);
});

test("a second account reaching the same receipt is a FoodFlow duplicate, not a second receipt", async () => {
  const loaded = await loadStore("publix");
  const archive = account("lisa");
  await capture(loaded, archive, { sources: ["api"], now: NOW });
  const result = await upload(loaded, archive, normalize(loaded, archive).records, client, { now: NOW });
  assert.deepEqual([result.uploaded.length, result.duplicates], [0, ["9999A1B100200"]]);
  assert.equal(foodflow.receipts.size, 1);
});

test("email fallback: used when the API session is dead, held while the API may still deliver", async () => {
  const loaded = await loadStore("publix");
  foodflow.receipts.clear();

  // Email-only account: no API capture has ever worked, so nothing is held.
  const emailOnly = new AccountArchive("publix", "emailonly", tempDir());
  mkdirSync(emailOnly.inboxDir, { recursive: true });
  cpSync(join(FIXTURES, "email-newer.eml"), join(emailOnly.inboxDir, "receipt.eml"));
  const captured = await capture(loaded, emailOnly, { now: NOW });
  assert.match(captured.sources.api?.error ?? "", /No Publix API session/);
  assert.deepEqual(captured.sources.email, { captured: 1, alreadyArchived: 0 });
  const recent = new Date("2020-07-04T22:00:00Z"); // two hours after the purchase
  const result = await upload(loaded, emailOnly, normalize(loaded, emailOnly).records, client, { now: recent });
  assert.deepEqual([result.uploaded.length, result.held], [1, []]);

  // Account that uses the API: a fresh email-only receipt waits for the API's richer copy...
  const both = account("both");
  await capture(loaded, both, { sources: ["api"], now: NOW });
  await capture(loaded, both, { sources: ["email"], options: { paths: [FIXTURES] }, now: NOW });
  const records = normalize(loaded, both).records;
  assert.deepEqual(
    records.map((r) => [r.externalId, r.captureSource]),
    [["9999A1B100200", "api"], ["9998X9X111222", "email"]],
    "the receipt captured both ways is normalized from the API copy"
  );
  const held = await upload(loaded, both, records, client, { now: recent });
  assert.deepEqual(held.held, ["9998X9X111222"]);
  // ...and goes up from email once the hold window has passed.
  const later = await upload(loaded, both, records, client, { now: new Date("2020-07-07T22:00:00Z") });
  assert.deepEqual([later.held, later.duplicates], [[], ["9998X9X111222"]]);
});

test("an expired session, a dry run, and a FoodFlow that predates the contract", async () => {
  const loaded = await loadStore("publix");
  const archive = account("expired");
  saveSession(archive.accountDir, { token: fakeJwt(-10, NOW), ecmsId: "1234567", userAgent: null, savedAt: NOW.toISOString() });
  const captured = await capture(loaded, archive, { sources: ["api"], now: NOW });
  assert.match(captured.sources.api?.error ?? "", /expired 10 min ago/);

  const fresh = account("fresh");
  await capture(loaded, fresh, { sources: ["api"], now: NOW });
  const records = normalize(loaded, fresh).records;
  const posts = foodflow.posts;
  const dry = await upload(loaded, fresh, records, null, { dryRun: true, now: NOW });
  assert.deepEqual([dry.uploaded.length, foodflow.posts - posts], [1, 0]);

  foodflow.contractVersion = undefined;
  const refused = await upload(loaded, fresh, records, client, { now: NOW });
  foodflow.contractVersion = CONTRACT_VERSION;
  assert.match(refused.aborted ?? "", /Update FoodFlow/);
  assert.deepEqual([refused.uploaded.length, foodflow.posts - posts], [0, 0]);
});
