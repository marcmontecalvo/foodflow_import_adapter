import type { StoreAdapter } from "../../core/adapter.ts";
import { browserLogin, hasBrowserProfile } from "./api/browser.ts";
import { captureApi } from "./api/capture.ts";
import { describeSession, loadSession, saveSession, sessionFromCurl } from "./api/session.ts";
import { captureEmail } from "./email/capture.ts";
import { normalize } from "./normalize/index.ts";

const publix: StoreAdapter = {
  capture: { api: captureApi, email: captureEmail },
  normalize,
  importSession(input, { accountDir, now }) {
    const session = sessionFromCurl(input, now);
    saveSession(accountDir, session);
    return describeSession(session, now);
  },
  async login({ accountDir, log }) {
    const session = await browserLogin(accountDir, log);
    return `signed in; ${describeSession(session, new Date())}, renewed from the browser profile on later runs`;
  },
  sessionStatus({ accountDir, now }) {
    const renews = hasBrowserProfile(accountDir) ? " (renews from the browser profile)" : " (no browser sign-in; will not renew)";
    return describeSession(loadSession(accountDir), now) + renews;
  },
};

export default publix;
