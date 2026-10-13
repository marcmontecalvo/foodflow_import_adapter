import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL("../stores/publix/fixtures/", import.meta.url));
export const fixture = (name: string) => readFileSync(join(FIXTURES, name));
export const fixtureJson = (name: string) => JSON.parse(fixture(name).toString("utf8"));
export const tempDir = () => mkdtempSync(join(tmpdir(), "ffimport-test-"));

/** A JWT-shaped token expiring `minutes` from `now`. Not signed. */
export function fakeJwt(minutes: number, now: Date = new Date()): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor(now.getTime() / 1000) + minutes * 60 })}.sig`;
}
