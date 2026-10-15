import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openBrowser, type Browser } from "../../../shared/browser.ts";
import { minutesLeft } from "../../../shared/jwt.ts";
import { saveSession, sessionFromCookies, type PublixSession } from "./session.ts";

/**
 * Staying signed in. The access token lasts about an hour, but publix.com
 * itself renews it from the longer-lived sign-in it keeps in the browser. So
 * the account gets a browser profile of its own: sign in once in a visible
 * window (`ffimport login`), and each later run reopens that profile on the
 * purchases page and reads the renewed token from its cookies.
 *
 * How long Publix keeps that sign-in alive without a visit is not documented;
 * polling a few times a day keeps it in use.
 */

const LOGIN_URL = "https://www.publix.com/login";
const PURCHASES_URL = "https://www.publix.com/account/purchases";
/** A token with less than this left is not worth starting a capture on. */
export const MIN_MINUTES = 5;

const profileDir = (accountDir: string) => join(accountDir, "browser-profile");

export function hasBrowserProfile(accountDir: string): boolean {
  return existsSync(profileDir(accountDir));
}

async function waitForSession(browser: Browser, timeoutMs: number): Promise<PublixSession | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && browser.isOpen()) {
    const cookies: Record<string, string> = {};
    for (const c of await browser.cookies().catch(() => [])) {
      if (/(^|\.)publix\.com$/i.test(c.domain)) cookies[c.name] = c.value;
    }
    const now = new Date();
    const session = sessionFromCookies(cookies, browser.userAgent, now);
    // The cookie keeps the expired token until the page has renewed it.
    if (session && (minutesLeft(session.token, now) ?? 60) > MIN_MINUTES) return session;
    await sleep(2000);
  }
  return null;
}

/** Interactive: open a window, wait for the user to sign in. */
export async function browserLogin(accountDir: string, log: (message: string) => void): Promise<PublixSession> {
  const browser = await openBrowser({ profileDir: profileDir(accountDir) });
  try {
    await browser.goto(LOGIN_URL);
    log("Sign in to Publix in the browser window that just opened (waiting up to 10 minutes)...");
    const session = await waitForSession(browser, 10 * 60_000);
    if (!session) throw new Error("No Publix sign-in was seen before the window closed or the wait ran out.");
    saveSession(accountDir, session);
    return session;
  } finally {
    await browser.close();
  }
}

/**
 * Unattended: reopen the profile and let the site renew the token. Tries
 * headless first, then a visible window, since sites sometimes refuse
 * headless browsers. FFIMPORT_HEADLESS=0 skips the headless attempt. Returns
 * null when the sign-in itself has lapsed and `login` is needed again.
 */
export async function renewSession(accountDir: string, log: (message: string) => void): Promise<PublixSession | null> {
  if (!hasBrowserProfile(accountDir)) return null;
  const attempts = process.env.FFIMPORT_HEADLESS === "0" ? [false] : [true, false];
  for (const headless of attempts) {
    let browser: Browser;
    try {
      browser = await openBrowser({ profileDir: profileDir(accountDir), headless });
    } catch (err) {
      log(`api: ${(err as Error).message}`);
      return null;
    }
    try {
      await browser.goto(PURCHASES_URL);
      const session = await waitForSession(browser, headless ? 45_000 : 90_000);
      if (session) {
        saveSession(accountDir, session);
        return session;
      }
    } catch (err) {
      log(`api: session renewal failed: ${(err as Error).message}`);
    } finally {
      await browser.close();
    }
  }
  return null;
}
