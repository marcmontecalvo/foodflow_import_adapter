import type { StoreAdapter } from "../../core/adapter.ts";
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
  sessionStatus({ accountDir, now }) {
    return describeSession(loadSession(accountDir), now);
  },
};

export default publix;
