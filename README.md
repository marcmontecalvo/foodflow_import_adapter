# foodflow_import_adapter

Store receipt adapters for FoodFlow. Each adapter pulls purchase history from
one store (its website/app API, its e-receipt emails, or both) and converts it
to FoodFlow's store-neutral structured receipt format. FoodFlow itself contains
no store-specific code: when a store changes its API or email format, only
that store's adapter changes.

Status: `core/`, `shared/` and the Publix adapter (API and email) are built.
The Publix email path is checked against real e-receipts; the Publix API path
is checked only against fixtures shaped like the API's responses and has not
yet been run against a live Publix session (see [Publix](#publix)).

## Quick start

Needs Node 22.18 or newer (it runs the TypeScript directly; there is no build
step and there are no runtime dependencies).

```bash
npm install                 # TypeScript, for `npm run typecheck` only
cp .env.example .env        # then set FOODFLOW_TOKEN
npm test
```

Mint the token in the FoodFlow checkout, with the `ingest` scope:

```bash
npx tsx scripts/create-api-client.ts create --name "import-adapter" --scopes read,ingest
```

Then, for each household member's store account (`--account` is a label you
choose, e.g. `marc`, `lisa`):

```bash
# Publix API: import a session from your browser (it lasts about an hour)
pbpaste | npm run ffimport -- auth publix --account marc

# capture + normalize + upload, from every source the account has
npm run ffimport -- run publix --account marc

# see what would be uploaded without sending anything
npm run ffimport -- run publix --account marc --dry-run
```

| Command | What it does |
|---|---|
| `stores` | List the adapters and when each was last verified. |
| `auth <store>` | Save a session from a pasted "Copy as cURL" (`--curl-file` or stdin). |
| `capture <store>` | Fetch raw receipts into the archive. `--source api,email`, `--from`/`--to`, `--eml <file-or-dir>`, `--refetch`. |
| `normalize <store>` | Rebuild the normalized JSONL from the archive. No network. |
| `upload <store>` | Normalize, then send what FoodFlow doesn't have yet. `--dry-run`, `--hold-hours`. |
| `run <store>` | `capture`, `normalize`, `upload` in one go. |
| `status <store>` | Session state, archive and upload counts, inbox path. |

Everything the importer keeps lives under `FFIMPORT_DATA_DIR` (default
`./data`, git-ignored): sessions, the raw archive, the normalized output and
the upload ledger. It is household data; back it up, don't publish it.

## Layout

```
core/        The stable FoodFlow component: the versioned output contract,
             validation, the FoodFlow upload client, the raw archive, and
             the run pipeline (capture -> normalize -> validate -> upload).
             This is the only part that changes when FoodFlow changes.
shared/      Helpers reused by multiple adapters: session capture (browser
             cURL import, token expiry), HTTP with retry and spacing, MIME
             and HTML-to-text, money and store-local time.
             NO store-specific parsing lives here — store formats drift
             independently, so parsers stay in their store folder.
stores/      One folder per store, all stores together (no category split:
             every store sells groceries and fills prescriptions).
  publix/
    adapter.json   Manifest: sources, auth, retention, last verified date.
    index.ts       The adapter: wires capture and normalize together.
    api/           Capture from the store website/app API.
    email/         Capture from e-receipt emails (fallback if the API breaks).
    normalize/     Raw -> structured receipts. Shared by every capture
                   source in the same store folder.
    fixtures/      Synthetic samples of each format, used by the tests.
test/        Parser, contract and pipeline tests (stub store API, stub FoodFlow).
```

Rules:

- No code imports across a store folder except through `shared/`.
- An adapter implements two things only: capture for each source it supports,
  and one normalize. Everything else is inherited from `core/`. The interface
  is `StoreAdapter` in `core/adapter.ts`.
- Raw payloads are stored verbatim (one file per receipt and source, named by
  the store's receipt ID) before normalization, so normalize can be re-run
  after a parser fix without re-fetching. Store history windows are short
  (Publix: ~180 days) and tokens expire (~1 hour), so the raw file is
  often the only copy.
- Fixtures are synthetic. Real receipts, emails and API responses carry names,
  card digits and purchase history and never go in this repo.

## Output format

Normalized output is JSONL (`data/normalized/<store>/<account>.jsonl`): one
structured receipt per line, matching FoodFlow's structured receipt schema,
plus an envelope per record:

- `contractVersion` — consumed by core's validator; a record FoodFlow
  cannot understand is refused before upload.
- `externalSource` + `externalId` — the store and its receipt ID; consumed
  by FoodFlow's dedupe (unique per household + source + ID) and by the
  raw archive naming.
- `accountLabel` — which household member's account this came from
  (e.g. `marc`, `lisa`); consumed by run reports and coverage checks.
- `capturedAt` + `captureSource` (`api` | `email` | `pdf`) — consumed by
  freshness/debugging reports when a store format drifts.

Each line item carries `name`, `quantity`/`unit`, `priceCents` (paid, net of
discounts), optional `listPriceCents`/`discountCents`/`dealType`, the flags
`isAdjustment` (coupons, fees) and `isVoided`, and `itemNumber` (the store's
UPC/PLU) when the source has one. The types and the validator are in
`core/contract.ts`.

## How it hooks into FoodFlow

Upload is `POST /api/household/receipts` with a bearer token; the household
comes from the token. Three things make re-runs safe:

1. **FoodFlow dedupes on `externalSource` + `externalId`.** A receipt already
   on file comes back `duplicate: true` and nothing is created. Two household
   members whose accounts both show a purchase, or a receipt that arrives by
   API and by email, land once.
2. **The upload ledger** (`data/state/…/uploaded.json`) remembers what was
   sent, so a routine run doesn't re-post months of history.
3. **A contract handshake.** Before uploading, core asks FoodFlow's `whoami`
   for `receiptContractVersion` and stops if FoodFlow is older than the
   records. A FoodFlow that predates external IDs would drop them silently and
   ingest every re-run as a new receipt.

This needs a FoodFlow with contract version 1: `externalSource`/`externalId`
on the structured receipt input, per-item `itemNumber`, and
`receiptContractVersion` on `whoami`.

Receipts FoodFlow already ingested through its own Publix email path need
their receipt IDs backfilled once (`scripts/backfill-publix-receipt-ids.ts`
in FoodFlow), or the adapter's copies of those purchases will not be
recognized as duplicates.

FoodFlow keeps the first copy of a receipt it is given. So that the richer
API copy usually wins, a receipt known only from a fallback source waits
`fallbackHoldHours` (Publix: 48) from purchase before it is uploaded. The hold
applies only to accounts that have captured from the primary source at least
once; `--hold-hours 0` turns it off.

## Publix

Sources, in preference order: `api`, then `email`. Both produce the same
`externalId` for a purchase, the printed receipt ID without spaces
(`9999 A1B 100 200` -> `9999A1B100200`).

**API.** Publix signs in through Azure AD B2C with 2FA, so the session is
imported rather than automated: sign in at publix.com, open Account >
Purchases with DevTools' Network tab open, right-click the request to
`services.publix.com/api/v1/PurchaseHistory`, Copy as cURL, and pipe it to
`ffimport auth publix --account <label>`. The token lasts about an hour;
Publix keeps about 180 days of history. Purchases younger than 24 hours are
left for a later run, because Publix publishes product detail a day or so
after the sale; a detail that comes back without product names is not
archived and is asked for again next time.

The API gives catalog product names, sizes and UPCs, which is why it is
preferred. It is also undocumented. The endpoints and field meanings here
follow [brett6320/publix_receipt_archiver](https://github.com/brett6320/publix_receipt_archiver),
which worked them out; none of its code is used. Not yet confirmed against a
live session from this code: that the service accepts HTTP/1.1 requests from
Node (the archiver uses HTTP/2), and that line `NetAmount`s plus `TaxAmount`
add up to `GrandTotal` on taxed receipts (if they don't, FoodFlow marks the
receipt `needs_review` and `normalize` reports it).

**Email.** Turn on e-receipts in your Publix account, then save or export the
emails as `.eml` into `data/inbox/publix/<label>/` (or pass `--eml <path>`).
A receipt is recognized by its content, so forwards work, including receipts
forwarded as attachments. Email receipts carry register abbreviations
(`OAT CEREAL`) and no UPCs. There is no mailbox polling: something else
has to put the `.eml` files in the folder.

Receipt times are read in the manifest's `timeZone` (`America/New_York`).

## Adding a store

1. `stores/<store>/adapter.json` — the manifest (`Manifest` in `core/adapter.ts`).
2. `stores/<store>/index.ts` — default-export a `StoreAdapter`: a `capture`
   function per source (an async generator of raw receipts, each with the
   store's receipt ID) and one `normalize` that turns a raw receipt into a
   structured receipt, or says it isn't ready.
3. Synthetic fixtures and tests.

## Build order

1. ~~`core/` + the FoodFlow-side contract additions it needs~~ — done.
2. ~~Publix API adapter with email fallback~~ — built; API path awaiting a
   first live run on both household accounts.
3. Costco.
4. Sam's Club, then Walgreens / Winn-Dixie (recon first — their purchase
   history depth is unverified).
