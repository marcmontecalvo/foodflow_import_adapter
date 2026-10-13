import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEml } from "../shared/mime.ts";
import { emailReceiptText } from "../stores/publix/normalize/fromEmail.ts";
import { parseReceiptText } from "../stores/publix/normalize/receiptText.ts";
import { fixture } from "./helpers.ts";

const textOf = (name: string) => {
  const message = parseEml(fixture(name));
  return emailReceiptText({ html: message.html.join("\n"), text: null });
};
const sum = (items: { priceCents?: number }[]) => items.reduce((s, i) => s + (i.priceCents ?? 0), 0);

test("classic format: header, totals and every line shape", () => {
  const r = parseReceiptText(textOf("email-classic.eml"));
  assert.equal(r.receiptId, "9999A1B100200");
  assert.equal(r.storeName, "Sample Plaza");
  assert.equal(r.storeNumber, "9999");
  assert.deepEqual(r.purchasedLocal, { year: 2020, month: 1, day: 15, hour: 16, minute: 38 });
  assert.equal(r.totalCents, 2386);
  assert.equal(r.taxCents, 38);
  assert.equal(sum(r.items) + 38, 2386, "lines + tax reconcile to the printed total");

  assert.deepEqual(
    r.items.map((i) => i.name),
    ["OAT CEREAL", "SPARKLING WATER", "VENDOR COUPON", "GREEK YOGURT", "GREEK YOGURT", "PASTA SAUCE", "GALA APPLES", "COLA 12PK", "COLA 12PK"]
  );
  const [cereal, water, coupon, yogurt, freeYogurt, sauce, apples, cola, colaVoid] = r.items;
  assert.deepEqual(
    { price: cereal?.priceCents, list: cereal?.listPriceCents, discount: cereal?.discountCents, deal: cereal?.dealType },
    { price: 499, list: 599, discount: 100, deal: "sale" }
  );
  assert.equal(water?.priceCents, 549);
  assert.equal(water?.discountCents, undefined);
  assert.deepEqual({ adj: coupon?.isAdjustment, price: coupon?.priceCents, deal: coupon?.dealType }, { adj: true, price: -100, deal: "coupon" });
  assert.equal(yogurt?.priceCents, 600);
  assert.deepEqual(
    { price: freeYogurt?.priceCents, list: freeYogurt?.listPriceCents, deal: freeYogurt?.dealType },
    { price: 0, list: 600, deal: "bogo" }
  );
  assert.deepEqual(
    { qty: sauce?.quantity, price: sauce?.priceCents, deal: sauce?.dealType, discount: sauce?.discountCents },
    { qty: 2, price: 500, deal: "multibuy", discount: 158 }
  );
  assert.deepEqual({ qty: apples?.quantity, unit: apples?.unit, price: apples?.priceCents }, { qty: 1.5, unit: "lb", price: 300 });
  // The void and the line it cancels are both kept off inventory; their prices cancel.
  assert.deepEqual({ voided: cola?.isVoided, price: cola?.priceCents }, { voided: true, price: 899 });
  assert.deepEqual({ voided: colaVoid?.isVoided, price: colaVoid?.priceCents }, { voided: true, price: -899 });
});

test("newer format: flag before the amount, $/lb weighing, bare receipt ID, 12-hour time", () => {
  const r = parseReceiptText(textOf("email-newer.eml"));
  assert.equal(r.receiptId, "9998X9X111222");
  assert.equal(r.storeName, "Example Crossing");
  assert.equal(r.storeNumber, "9998");
  assert.deepEqual(r.purchasedLocal, { year: 2020, month: 7, day: 4, hour: 16, minute: 9 });
  assert.equal(r.totalCents, 2042);
  assert.equal(r.taxCents, 97);
  assert.equal(sum(r.items) + 97, 2042);

  assert.deepEqual(
    r.items.map((i) => i.name),
    ["Waffle Mix Dbl Choc", "Waffle Mix Buttermilk", "Bananas", "Wings Party 20Pc", "Publix Eggs Large 12Ct", "Club Pub 1/2 Bday"]
  );
  const [free, , bananas, wings, , club] = r.items;
  assert.deepEqual({ price: free?.priceCents, list: free?.listPriceCents, deal: free?.dealType }, { price: 0, list: 659, deal: "bogo" });
  assert.deepEqual({ qty: bananas?.quantity, unit: bananas?.unit, price: bananas?.priceCents }, { qty: 1.82, unit: "lb", price: 118 });
  assert.deepEqual({ price: wings?.priceCents, list: wings?.listPriceCents, deal: wings?.dealType }, { price: 1299, list: 1699, deal: "sale" });
  assert.deepEqual({ adj: club?.isAdjustment, price: club?.priceCents }, { adj: true, price: -330 });
  // The "Voided Items" block prints after the totals and is not part of the purchase.
  assert.equal(r.items.filter((i) => i.name === "Waffle Mix Buttermilk").length, 1);
});

test("spacing collapsed by a mail client still parses", () => {
  const collapsed = [
    "Publix Super Markets, Inc.",
    "Sample Plaza",
    "100 Example Ave",
    "Store Manager: Pat Example",
    "BANANAS 1.18 F",
    "Milk Whole T 3.49",
    "TOMATO BEEFSTEAK",
    "0.75 lb @ 2.99/ lb 2.24 F",
    "TOTAL CEREAL 4.00 F",
    "Subtotal 10.91",
    "Sales Tax 7.5% - T 0.26",
    "Total 11.17",
    "5417 9660 5160 3902 038",
    "09/10/2020 06:04PM",
  ].join("\n");
  const r = parseReceiptText(collapsed);
  assert.equal(r.receiptId, "5417966051603902038");
  assert.deepEqual(r.items.map((i) => [i.name, i.priceCents]), [
    ["BANANAS", 118],
    ["Milk Whole", 349],
    ["TOMATO BEEFSTEAK", 224],
    // A product whose name starts with "Total" is not the totals row.
    ["TOTAL CEREAL", 400],
  ]);
  assert.equal(r.totalCents, 1117);
  assert.equal(r.taxCents, 26);
  assert.equal(r.purchasedLocal?.hour, 18);
});

test("a name with no price line is kept at low confidence, not dropped", () => {
  const r = parseReceiptText("Store Manager: X\n  MYSTERY ITEM\n  BREAD   2.50 F\n  Order Total  2.50\n  Grand Total  2.50\n");
  assert.deepEqual(r.items.map((i) => [i.name, i.priceCents, i.confidence]), [
    ["MYSTERY ITEM", undefined, 0.35],
    ["BREAD", 250, 0.8],
  ]);
});

test("a name ending in a decimal is still a name when a quantity row follows", () => {
  const r = parseReceiptText(
    ["Store Manager: X", "  PIE CRUST 15.25", "  1 @   2 FOR      4.00         2.00   F", "  Supervisor #829", "  BREAD   2.50 F", "  Age Bypassed", "  Order Total  4.50", "  Grand Total  4.50"].join("\n")
  );
  assert.deepEqual(r.items.map((i) => [i.name, i.priceCents]), [
    ["PIE CRUST 15.25", 200],
    ["BREAD", 250],
  ]);
});

test("a refund receipt: goods handed back never become inventory", () => {
  const r = parseReceiptText(
    ["Refunded Item", "  CHICKEN DRUMSTICKS", "  4.42 lb @    -2.28/ lb      -10.12   F", "    Order Total   -10.12", "      Sales Tax     0.00", "    Grand Total   -10.12", "      Receipt ID: 9999 R3F 000 111"].join("\n")
  );
  assert.deepEqual(r.items.map((i) => [i.name, i.priceCents, i.isVoided, i.note]), [["CHICKEN DRUMSTICKS", -1012, true, "refunded"]]);
  assert.equal(r.totalCents, -1012);
});
