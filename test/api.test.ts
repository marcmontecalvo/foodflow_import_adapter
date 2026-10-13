import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCurl } from "../shared/curl.ts";
import { describeSession, sessionFromCurl } from "../stores/publix/api/session.ts";
import { isUnpublished, normalizeApi } from "../stores/publix/normalize/fromApi.ts";
import { fakeJwt, fixtureJson } from "./helpers.ts";

const manifest = fixtureJson("../adapter.json");
const ctx = { manifest, accountLabel: "test", timeZone: "America/New_York" };
const list = fixtureJson("api-list.json").CurrentTransactions[2];
const detail = fixtureJson("api-detail.json");

test("api normalize: catalog names, item numbers, weights, deals, coupons", () => {
  const result = normalizeApi({ list, detail }, ctx);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const { receipt } = result;
  assert.equal(receipt.storeName, "Publix Sample Plaza");
  assert.equal(receipt.purchasedAt, "2020-01-15T21:38:00.000Z");
  assert.equal(receipt.totalCents, 1356);
  assert.equal(receipt.taxCents, 107);
  assert.match(receipt.sourceText ?? "", /^ {2}GALA APPLES\n/, "escaped newlines in ReceiptText are decoded");
  assert.deepEqual(receipt.items, [
    { name: "Gala Apples", itemNumber: "4133", quantity: 1.5, unit: "lb", priceCents: 300, confidence: 0.95 },
    {
      name: "Example Farms Oat Milk, 64 oz",
      itemNumber: "1234500012",
      quantity: 1,
      priceCents: 449,
      confidence: 0.95,
      // SavingAmount on a sale price is already inside the printed amount.
      discountCents: 50,
      listPriceCents: 499,
      dealType: "sale",
    },
    { name: "Sample's Greek Yogurt, 32 oz", itemNumber: "1234500029", quantity: 1, priceCents: 600, confidence: 0.95 },
    {
      // This line carried the catalog ItemId instead of the UPC; same product, same item number.
      name: "Sample's Greek Yogurt, 32 oz",
      itemNumber: "1234500029",
      quantity: 1,
      priceCents: 0,
      confidence: 0.95,
      discountCents: 600,
      listPriceCents: 600,
      dealType: "bogo",
    },
    { name: "Vendor Coupon", priceCents: -100, isAdjustment: true, dealType: "coupon" },
  ]);
  const sum = receipt.items.reduce((s, i) => s + (i.priceCents ?? 0), 0);
  assert.equal(sum + 107, 1356);
});

test("a detail with no product names yet is not normalized", () => {
  const unpublished = { ...detail, Products: [] };
  assert.equal(isUnpublished(unpublished), true);
  assert.deepEqual(normalizeApi({ list, detail: unpublished }, ctx), {
    status: "skip",
    reason: "detail not published yet (no product names)",
  });
});

test("a detail that carries only the printed text falls back to the text parser", () => {
  const result = normalizeApi({ list, detail: { ...detail, ReceiptLineItems: [], Products: [] } }, ctx);
  assert.equal(result.status === "ok" && result.receipt.items.length, 5);
  assert.equal(result.status === "ok" && result.receipt.items[0]?.name, "GALA APPLES");
});

test("session import from the API request's cURL (bash and cmd flavors)", () => {
  const now = new Date("2020-01-15T12:00:00Z");
  const token = fakeJwt(42, now);
  const bash =
    `curl 'https://services.publix.com/api/v1/PurchaseHistory?page=1&size=10' \\\n` +
    `  -H 'accept: application/json' \\\n  -H 'authorization: Bearer ${token}' \\\n` +
    `  -H 'ecmsid: 1234567' \\\n  -H 'user-agent: TestBrowser/1.0 (it''s fine)' --compressed`;
  const session = sessionFromCurl(bash, now);
  assert.deepEqual({ token: session.token, ecmsId: session.ecmsId }, { token, ecmsId: "1234567" });
  assert.equal(describeSession(session, now), "API session valid for about 42 more min");
  assert.match(describeSession(session, new Date("2020-01-15T13:00:00Z")), /expired 18 min ago/);

  const cmd = `curl "https://services.publix.com/api/v1/PurchaseHistory" ^\n  -H "authorization: Bearer ${token}" ^\n  -H "EcmsId: 7654321"`;
  assert.equal(sessionFromCurl(cmd, now).ecmsId, "7654321");
});

test("session import from any signed-in page request's cookies", () => {
  const now = new Date();
  const user = encodeURIComponent(JSON.stringify({ EcmsId: "555", FirstName: "Pat" }));
  const curl = `curl 'https://www.publix.com/account' -b 'foo=bar; AccessTokenJwt=${fakeJwt(5)}; User=${user}'`;
  assert.equal(sessionFromCurl(curl, now).ecmsId, "555");
  assert.equal(parseCurl(curl).cookies.foo, "bar");
});

test("a cURL without credentials is refused with instructions", () => {
  assert.throws(() => sessionFromCurl("curl 'https://www.publix.com/'", new Date()), /No Publix credentials/);
  assert.throws(() => sessionFromCurl("GET /api", new Date()), /not a cURL command/);
});
