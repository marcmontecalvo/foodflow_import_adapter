import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, reconcile, toUploadBody, validateRecord, type ReceiptRecord } from "../core/contract.ts";

const good = (): ReceiptRecord => ({
  contractVersion: CONTRACT_VERSION,
  externalSource: "publix",
  externalId: "9999A1B100200",
  accountLabel: "marc",
  capturedAt: "2020-01-16T00:00:00.000Z",
  captureSource: "api",
  storeName: "Publix Sample Plaza",
  purchasedAt: "2020-01-15T21:38:00.000Z",
  totalCents: 500,
  taxCents: 0,
  items: [
    { name: "Bread", priceCents: 600 },
    { name: "Coupon", priceCents: -100, isAdjustment: true },
  ],
});

test("a well-formed record validates and reconciles", () => {
  assert.deepEqual(validateRecord(good()), []);
  assert.deepEqual(reconcile(good()), { differenceCents: 0 });
});

test("what FoodFlow would reject is refused before upload", () => {
  const cases: [string, (r: ReceiptRecord) => void, RegExp][] = [
    ["future contract", (r) => (r.contractVersion = CONTRACT_VERSION + 1), /contractVersion/],
    ["no items", (r) => (r.items = []), /at least one line/],
    ["offset timestamp", (r) => (r.purchasedAt = "2020-01-15T16:38:00-05:00"), /purchasedAt/],
    ["negative product price", (r) => (r.items[0] = { name: "Bread", priceCents: -5 }), /negative/],
    ["fractional cents", (r) => (r.items[0] = { name: "Bread", priceCents: 1.5 }), /integer/],
    ["zero quantity", (r) => (r.items[0] = { name: "Bread", quantity: 0 }), /quantity/],
    ["negative total", (r) => (r.totalCents = -1012), /totalCents/],
    ["missing id", (r) => (r.externalId = ""), /externalId/],
  ];
  for (const [label, mutate, expected] of cases) {
    const record = good();
    mutate(record);
    assert.match(validateRecord(record).join("; "), expected, label);
  }
});

test("the upload body carries the receipt and its identity, not the adapter envelope", () => {
  assert.deepEqual(Object.keys(toUploadBody(good())).sort(), ["externalId", "externalSource", "items", "purchasedAt", "storeName", "taxCents", "totalCents"]);
});
