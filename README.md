# foodflow_import_adapter

Store receipt adapters for FoodFlow. Each adapter pulls purchase history from
one store (its website/app API, its e-receipt emails, or both) and converts it
to FoodFlow's store-neutral structured receipt format. FoodFlow itself contains
no store-specific code: when a store changes its API or email format, only
that store's adapter changes.

## Layout

```
core/        The stable FoodFlow component: the versioned output contract,
             validation, the FoodFlow upload client, the raw archive, and
             the run pipeline (capture -> normalize -> validate -> upload).
             This is the only part that changes when FoodFlow changes.
shared/      Helpers reused by multiple adapters: auth/session capture
             (browser cURL import, token expiry), HTTP with retry and rate
             limits, date-window paging, fixture test harness.
             NO store-specific parsing lives here — store formats drift
             independently, so parsers stay in their store folder.
stores/      One folder per store, all stores together (no category split:
             every store sells groceries and fills prescriptions).
  publix/
    adapter.json   Manifest: sources, auth, retention, last verified date.
    api/           Capture from the store website/app API.
    email/         Capture from e-receipt emails (fallback if the API breaks).
    normalize/     Raw -> structured receipts. Shared by every capture
                   source in the same store folder.
```

Rules:

- No code imports across a store folder except through `shared/`.
- An adapter implements two things only: capture for each source it supports,
  and one normalize. Everything else is inherited from `core/`.
- Raw payloads are stored verbatim (one file per receipt, named by the
  store's receipt ID) before normalization, so normalize can be re-run after
  a parser fix without re-fetching. Store history windows are short
  (Publix: ~180 days) and tokens expire (~1 hour), so the raw file is
  often the only copy.

## Output format

Normalized output is JSONL: one structured receipt per line, matching
FoodFlow's structured receipt schema, plus an envelope per record:

- `contractVersion` — consumed by core's validator; a record FoodFlow
  cannot understand is refused before upload.
- `externalSource` + `externalId` — the store and its receipt ID; consumed
  by FoodFlow's dedupe (unique per household + source + ID) and by the
  raw archive naming.
- `accountLabel` — which household member's account this came from
  (e.g. `marc`, `lisa`); consumed by run reports and coverage checks.
- `capturedAt` + `captureSource` (`api` | `email` | `pdf`) — consumed by
  freshness/debugging reports when a store format drifts.

## Build order

1. `core/` + the FoodFlow-side contract additions it needs
   (`externalId`/`externalSource` and per-item `itemNumber` on the
   structured input — FoodFlow's database already stores both; the
   external schema does not expose them yet).
2. Publix API adapter (both household accounts) with email fallback.
3. Costco.
4. Sam's Club, then Walgreens / Winn-Dixie (recon first — their purchase
   history depth is unverified).
