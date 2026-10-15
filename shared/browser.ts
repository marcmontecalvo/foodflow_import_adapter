import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Drive the user's installed Chrome (or Edge/Chromium) over the DevTools
 * protocol, with a profile directory of its own. Stores that sign in through
 * an interactive flow (SSO, 2FA) keep their session in that profile: the user
 * signs in once in a visible window, and later runs reopen the profile to pick
 * up a renewed token without anyone present.
 *
 * No browser is downloaded and no driver library is needed: Node's built-in
 * WebSocket speaks the protocol directly.
 */

export interface Cookie {
  name: string;
  value: string;
  domain: string;
}

export interface Browser {
  /** The browser's real user agent (never the "HeadlessChrome" one). */
  userAgent: string;
  goto(url: string): Promise<void>;
  /** Every cookie in the profile, across all sites. */
  cookies(): Promise<Cookie[]>;
  /** False once the window was closed or the process exited. */
  isOpen(): boolean;
  close(): Promise<void>;
}

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** FFIMPORT_BROWSER overrides the search. */
export function findBrowser(): string | null {
  const override = process.env.FFIMPORT_BROWSER;
  if (override) return existsSync(override) ? override : null;
  return CANDIDATES.find((path) => existsSync(path)) ?? null;
}

export async function openBrowser(opts: { profileDir: string; headless?: boolean }): Promise<Browser> {
  const binary = findBrowser();
  if (!binary) {
    throw new Error("No Chrome, Edge or Chromium found. Install one, or point FFIMPORT_BROWSER at the executable.");
  }
  mkdirSync(opts.profileDir, { recursive: true, mode: 0o700 });
  // Chrome writes the port it picked here; a leftover from the last run would be read as this run's.
  const portFile = join(opts.profileDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });

  const child = spawn(
    binary,
    [
      `--user-data-dir=${opts.profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      ...(opts.headless ? ["--headless=new", "--window-size=1280,900"] : []),
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  let open = true;
  child.once("exit", () => (open = false));
  child.once("error", () => (open = false));

  let endpoint = "";
  for (let waited = 0; waited < 20_000 && !endpoint; waited += 200) {
    await sleep(200);
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split("\n");
      if (port && path) endpoint = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    } else if (!open) break;
  }
  if (!endpoint) {
    child.kill();
    // A second Chrome on a profile hands off to the first and exits.
    throw new Error(`The browser did not start on ${opts.profileDir}. If a window on this profile is still open, close it and retry.`);
  }

  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to the browser.")), { once: true });
  });
  socket.addEventListener("close", () => (open = false));

  let nextId = 1;
  const waiting = new Map<number, { resolve(value: any): void; reject(err: Error): void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => {
    if (!open) return Promise.reject(new Error("The browser was closed."));
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  };

  const version = await send("Browser.getVersion");
  const userAgent = String(version.userAgent).replace("HeadlessChrome", "Chrome");
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t: { type: string }) => t.type === "page");
  const targetId = page?.targetId ?? (await send("Target.createTarget", { url: "about:blank" })).targetId;
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  if (opts.headless) await send("Emulation.setUserAgentOverride", { userAgent }, sessionId);

  return {
    userAgent,
    goto: async (url) => {
      await send("Page.navigate", { url }, sessionId);
    },
    cookies: async () => (await send("Storage.getCookies")).cookies as Cookie[],
    isOpen: () => open,
    close: async () => {
      if (!open) return;
      // Browser.close lets Chrome flush the profile's cookies to disk first.
      await send("Browser.close").catch(() => {});
      for (let waited = 0; waited < 5000 && open; waited += 100) await sleep(100);
      if (open) child.kill();
    },
  };
}
