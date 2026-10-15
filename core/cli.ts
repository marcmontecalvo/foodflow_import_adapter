#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { listStores, loadStore } from "./adapter.ts";
import { AccountArchive } from "./archive.ts";
import { CAPTURE_SOURCES, type CaptureSource } from "./contract.ts";
import { FoodFlowClient, foodFlowConfigFromEnv } from "./foodflow.ts";
import { capture, normalize, upload, type CaptureSummary, type NormalizeSummary, type UploadSummary } from "./pipeline.ts";

const USAGE = `ffimport: store receipt adapters for FoodFlow

  ffimport stores
  ffimport login     <store> --account <label>                        sign in once in a browser window; renews itself
  ffimport auth      <store> --account <label> [--curl-file <path>]   one-hour session from a pasted cURL (or stdin)
  ffimport capture   <store> --account <label> [--source api,email] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                                               [--eml <file-or-dir> ...] [--refetch]
  ffimport normalize <store> --account <label>
  ffimport upload    <store> --account <label> [--dry-run] [--hold-hours <n>]
  ffimport run       <store> --account <label> [capture and upload options]   capture + normalize + upload
  ffimport watch     <store> --account <label> [--every 6h] [run options]     run now, then again every interval
  ffimport status    <store> --account <label>

--account names whose store account this is (e.g. marc). Each account keeps its
own session, raw archive and upload ledger under FFIMPORT_DATA_DIR (./data).
FoodFlow is reached at FOODFLOW_URL with FOODFLOW_TOKEN (see .env.example).`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const log = (message: string) => console.error(`  ${message}`);

function printCapture(summary: CaptureSummary): void {
  for (const [source, c] of Object.entries(summary.sources)) {
    console.log(`capture ${source}: ${c.captured} new, ${c.alreadyArchived} already archived${c.error ? `, FAILED: ${c.error}` : ""}`);
  }
}

function printNormalize(summary: NormalizeSummary, path: string): void {
  console.log(`normalize: ${summary.records.length} receipt(s) -> ${path}`);
  for (const s of summary.skipped) console.log(`  not ready  ${s.externalId}: ${s.reason}`);
  for (const s of summary.invalid) console.log(`  INVALID    ${s.externalId}: ${s.problems.join("; ")}`);
  for (const s of summary.unreconciled) {
    console.log(`  off by ${(s.differenceCents / 100).toFixed(2)}  ${s.externalId}: lines + tax != printed total (FoodFlow will mark it needs_review)`);
  }
}

function printUpload(summary: UploadSummary): void {
  const verb = summary.dryRun ? "would upload" : "uploaded";
  console.log(
    `upload: ${verb} ${summary.uploaded.length}, ${summary.duplicates.length} already in FoodFlow, ` +
      `${summary.alreadyUploaded} uploaded earlier, ${summary.held.length} held, ${summary.failed.length} failed`
  );
  for (const u of summary.uploaded) {
    if (u.parseStatus === "needs_review") console.log(`  needs review  ${u.externalId} (FoodFlow receipt ${u.receiptId})`);
  }
  for (const p of summary.probableDuplicates) {
    console.log(`  LOOKALIKE  ${p.externalId}: FoodFlow is holding receipt ${p.receiptId} as a probable duplicate of ${p.of}; resolve it there`);
  }
  if (summary.held.length) console.log(`  held for the primary source: ${summary.held.join(", ")}`);
  if (summary.richerNotApplied.length) {
    console.log(`  richer capture exists but FoodFlow keeps the first upload: ${summary.richerNotApplied.join(", ")}`);
  }
  for (const f of summary.failed) console.log(`  FAILED  ${f.externalId}: ${f.error}`);
  if (summary.aborted) console.log(`  STOPPED: ${summary.aborted}`);
}

/** "6h", "90m", "1d"; a bare number is hours. Null when unreadable or under 15 minutes. */
export function intervalMs(text: string): number | null {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*([mhd]?)$/i);
  if (!m) return null;
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || "h").toLowerCase() as "m" | "h" | "d"];
  return ms >= 15 * 60_000 ? ms : null;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      account: { type: "string" },
      source: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      eml: { type: "string", multiple: true },
      refetch: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "hold-hours": { type: "string" },
      "curl-file": { type: "string" },
      every: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, store] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === "stores") {
    for (const name of listStores()) {
      const { manifest, adapter } = await loadStore(name);
      const sources = manifest.sources.filter((s) => adapter.capture[s]).join(", ");
      console.log(`${name}\t${manifest.displayName}\tsources: ${sources}\tlast verified: ${manifest.lastVerified ?? "never"}`);
    }
    return 0;
  }
  if (!["login", "auth", "capture", "normalize", "upload", "run", "watch", "status"].includes(command)) fail(`Unknown command "${command}".\n\n${USAGE}`);
  if (!store) fail(`${command} needs a store.\n\n${USAGE}`);
  if (!values.account) fail("--account <label> is required (whose store account this is, e.g. --account marc).");
  for (const date of [values.from, values.to]) {
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`"${date}" is not a YYYY-MM-DD date.`);
  }

  const loaded = await loadStore(store);
  const archive = new AccountArchive(store, values.account);
  let now = new Date();
  const everyMs = intervalMs(values.every ?? "6h");
  if (everyMs === null) fail('--every takes an interval such as 6h, 90m or 1d (15 minutes or more).');

  const sources = values.source?.split(",").map((s) => s.trim()) as CaptureSource[] | undefined;
  for (const s of sources ?? []) {
    if (!CAPTURE_SOURCES.includes(s) || !loaded.adapter.capture[s]) fail(`${loaded.manifest.displayName} has no "${s}" capture.`);
  }
  const holdHours = values["hold-hours"] === undefined ? undefined : Number(values["hold-hours"]);
  if (holdHours !== undefined && !(holdHours >= 0)) fail("--hold-hours must be a number of hours, 0 or more.");
  const captureOpts = () => ({
    sources,
    options: { from: values.from, to: values.to, paths: values.eml, refetch: values.refetch },
    now,
    log,
  });
  const doUpload = async (summary: NormalizeSummary) => {
    const dryRun = values["dry-run"] ?? false;
    const client = dryRun ? null : new FoodFlowClient(foodFlowConfigFromEnv());
    const result = await upload(loaded, archive, summary.records, client, { dryRun, holdHours, now, log });
    printUpload(result);
    return result.aborted || result.failed.length ? 1 : 0;
  };

  const runOnce = async () => {
    const captured = await capture(loaded, archive, captureOpts());
    printCapture(captured);
    const summary = normalize(loaded, archive);
    printNormalize(summary, archive.normalizedPath);
    const code = await doUpload(summary);
    // A failed source is reported but doesn't fail the run when another source delivered.
    const allSourcesFailed = Object.values(captured.sources).every((s) => s.error);
    return code || (allSourcesFailed || summary.invalid.length ? 1 : 0);
  };

  switch (command) {
    case "login": {
      if (!loaded.adapter.login) fail(`${loaded.manifest.displayName} has no browser sign-in.`);
      console.log(`${loaded.manifest.displayName} (${archive.accountLabel}): ${await loaded.adapter.login({ accountDir: archive.accountDir, log })}`);
      return 0;
    }
    case "auth": {
      if (!loaded.adapter.importSession) fail(`${loaded.manifest.displayName} has no session to import.`);
      const input = values["curl-file"] ? readFileSync(values["curl-file"], "utf8") : await readStdin();
      if (!input.trim()) fail("Pass the copied cURL with --curl-file <path>, or pipe it on stdin (e.g. pbpaste | ffimport auth ...).");
      console.log(`${loaded.manifest.displayName} (${archive.accountLabel}): ${loaded.adapter.importSession(input, { accountDir: archive.accountDir, now })}`);
      return 0;
    }
    case "capture": {
      const summary = await capture(loaded, archive, captureOpts());
      printCapture(summary);
      return Object.values(summary.sources).some((s) => s.error) ? 1 : 0;
    }
    case "normalize": {
      const summary = normalize(loaded, archive);
      printNormalize(summary, archive.normalizedPath);
      return summary.invalid.length ? 1 : 0;
    }
    case "upload": {
      const summary = normalize(loaded, archive);
      printNormalize(summary, archive.normalizedPath);
      return doUpload(summary);
    }
    case "run":
      return runOnce();
    case "watch": {
      // Runs until stopped. A failed cycle is reported and the next one still happens.
      for (;;) {
        now = new Date();
        console.log(`\n[${now.toISOString()}] ${loaded.manifest.displayName} (${archive.accountLabel})`);
        const code = await runOnce().catch((err) => {
          console.log(`  FAILED: ${(err as Error).message}`);
          return 1;
        });
        console.log(`${code ? "finished with problems" : "ok"}; next run ${new Date(Date.now() + everyMs).toLocaleString()}`);
        await sleep(everyMs);
      }
    }
    case "status": {
      const ledger = archive.readLedger();
      console.log(`${loaded.manifest.displayName} (${archive.accountLabel})`);
      if (loaded.adapter.sessionStatus) console.log(`  session:   ${loaded.adapter.sessionStatus({ accountDir: archive.accountDir, now })}`);
      for (const s of loaded.manifest.sources) console.log(`  archived:  ${archive.listRaw(s).length} from ${s}`);
      console.log(`  uploaded:  ${Object.keys(ledger).length}`);
      console.log(`  inbox:     ${archive.inboxDir}`);
      return 0;
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => fail(`ffimport: ${(err as Error).message}`)
);
