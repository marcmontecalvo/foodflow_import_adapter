import type { NormalizeContext, NormalizeResult, RawReceipt } from "../../../core/adapter.ts";
import { normalizeApi, type ApiPayload } from "./fromApi.ts";
import { normalizeEmail, type EmailPayload } from "./fromEmail.ts";

/** Raw -> structured receipt, for every capture source in this store folder. */
export function normalize(raw: RawReceipt, ctx: NormalizeContext): NormalizeResult {
  switch (raw.captureSource) {
    case "api":
      return normalizeApi(raw.payload as ApiPayload, ctx);
    case "email":
      return normalizeEmail(raw.payload as EmailPayload, ctx);
    default:
      return { status: "skip", reason: `no Publix normalizer for "${raw.captureSource}"` };
  }
}
