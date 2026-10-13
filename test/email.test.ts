import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CaptureContext, RawReceipt } from "../core/adapter.ts";
import { allMessages, parseEml } from "../shared/mime.ts";
import { captureEmail } from "../stores/publix/email/capture.ts";
import { normalizeEmail, type EmailPayload } from "../stores/publix/normalize/fromEmail.ts";
import { FIXTURES, fixture, fixtureJson, tempDir } from "./helpers.ts";

const manifest = fixtureJson("../adapter.json");

async function captureFrom(paths: string[]): Promise<RawReceipt[]> {
  const ctx: CaptureContext = {
    manifest,
    accountLabel: "test",
    accountDir: tempDir(),
    inboxDir: tempDir(),
    options: { paths },
    now: new Date(),
    archived: () => [],
    log: () => {},
  };
  const out: RawReceipt[] = [];
  for await (const raw of captureEmail(ctx)) out.push(raw);
  return out;
}

const normalizeCtx = { manifest, accountLabel: "test", timeZone: "America/New_York" };

test("a folder of .eml files yields one raw receipt per Publix receipt", async () => {
  const raws = await captureFrom([FIXTURES]);
  assert.deepEqual(raws.map((r) => r.externalId).sort(), ["9998X9X111222", "9999A1B100200"]);
  assert.ok(raws.every((r) => r.captureSource === "email"));
});

test("email normalize: store, instant in the store's zone, totals, audit text", async () => {
  const [raw] = (await captureFrom([join(FIXTURES, "email-classic.eml")])) as [RawReceipt];
  const result = normalizeEmail(raw.payload as EmailPayload, normalizeCtx);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const { receipt } = result;
  assert.equal(receipt.storeName, "Publix Sample Plaza");
  assert.equal(receipt.purchasedAt, "2020-01-15T21:38:00.000Z"); // 16:38 EST
  assert.equal(receipt.totalCents, 2386);
  assert.equal(receipt.taxCents, 38);
  assert.equal(receipt.items.length, 9);
  assert.match(receipt.sourceText ?? "", /Receipt ID: 9999 A1B 100 200/);
  assert.doesNotMatch(receipt.sourceText ?? "", /This email was sent to/, "marketing footer is cut");

  const [summer] = (await captureFrom([join(FIXTURES, "email-newer.eml")])) as [RawReceipt];
  const newer = normalizeEmail(summer.payload as EmailPayload, normalizeCtx);
  assert.equal(newer.status === "ok" && newer.receipt.purchasedAt, "2020-07-04T20:09:00.000Z"); // 4:09 PM EDT
  assert.equal(newer.status === "ok" && newer.receipt.storeName, "Publix Example Crossing");
});

/** Wrap a message as an attachment of a forward, the way mail clients do. */
function forwardWith(parts: string[]): Buffer {
  const boundary = "fwd-outer";
  const body = [
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n`,
    ...parts.map((p) => `--${boundary}\r\n${p}\r\n`),
    `--${boundary}--\r\n`,
  ].join("");
  return Buffer.from(
    `From: Me <me@example.invalid>\r\nSubject: Fwd: receipts\r\nMIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${body}`
  );
}

test("receipts forwarded as attachments are found; other attachments are ignored", async () => {
  const classic = fixture("email-classic.eml").toString("latin1");
  const newerB64 = fixture("email-newer.eml").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const eml = forwardWith([
    `Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="a.eml"\r\n\r\n${classic}`,
    `Content-Type: application/octet-stream; name="b.eml"\r\nContent-Transfer-Encoding: base64\r\n\r\n${newerB64}`,
    `Content-Type: image/jpeg; name="pic.jpg"\r\nContent-Transfer-Encoding: base64\r\n\r\n/9j/4AAQ`,
  ]);
  assert.equal([...allMessages(parseEml(eml))].length, 3);
  const dir = tempDir();
  writeFileSync(join(dir, "forward.eml"), eml);
  const raws = await captureFrom([dir]);
  assert.deepEqual(raws.map((r) => r.externalId).sort(), ["9998X9X111222", "9999A1B100200"]);
});

test("mail that is not a receipt is ignored", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "ad.eml"),
    'From: "Publix" <news@exact.publix.com>\r\nSubject: Weekly ad\r\nContent-Type: text/html\r\n\r\n<p>BOGO deals this week! Total savings 5.00</p>'
  );
  writeFileSync(join(dir, "note.eml"), "From: a@example.invalid\r\nSubject: hi\r\n\r\njust a note\r\n");
  assert.deepEqual(await captureFrom([dir]), []);
});

test("quoted-printable bodies decode, including soft line breaks and UTF-8", () => {
  const message = parseEml(
    "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" +
      "<p>Caf=C3=A9 total =3D 4.00 and a very long line that the sender wrapped =\r\nright here</p>"
  );
  assert.equal(message.html[0], "<p>Café total = 4.00 and a very long line that the sender wrapped right here</p>");
});
