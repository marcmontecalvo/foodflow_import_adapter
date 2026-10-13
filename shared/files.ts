import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Read/write a private JSON file under an account directory (sessions hold bearer tokens). */
export function readPrivateJson<T>(dir: string, name: string): T | null {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writePrivateJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
