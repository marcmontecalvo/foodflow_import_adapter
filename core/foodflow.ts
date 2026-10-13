import { CONTRACT_VERSION, toUploadBody, type ReceiptRecord } from "./contract.ts";

/**
 * FoodFlow upload client: POST /api/household/receipts with a bearer token
 * that holds the `ingest` scope. The household comes from the token.
 */

export class FoodFlowError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface UploadResult {
  receiptId: string;
  /** FoodFlow already had this (externalSource, externalId) and created nothing. */
  duplicate: boolean;
  /** "parsed" or "needs_review". */
  parseStatus: string;
  itemCount: number;
  reconciled: boolean | null;
  differenceCents: number | null;
  /**
   * Set when FoodFlow holds the receipt as a lookalike of an earlier one that
   * has no external ID (e.g. the same purchase entered by hand). It is stored
   * but kept out of inventory until someone resolves it in FoodFlow.
   */
  probableDuplicateOf: string | null;
}

export interface Identity {
  clientName: string;
  householdId: string;
  householdName: string | null;
  scopes: string[];
  /** Structured receipt contract version this FoodFlow speaks. Absent on a FoodFlow that predates external IDs. */
  receiptContractVersion?: number;
}

export interface FoodFlowConfig {
  baseUrl: string;
  token: string;
}

export function foodFlowConfigFromEnv(): FoodFlowConfig {
  const token = process.env.FOODFLOW_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "FOODFLOW_TOKEN is not set. Mint a token with the ingest scope in the FoodFlow checkout " +
        '(npx tsx scripts/create-api-client.ts create --name "import-adapter" --scopes read,ingest) and put it in .env.'
    );
  }
  return { baseUrl: (process.env.FOODFLOW_URL || "http://127.0.0.1:3000").replace(/\/+$/, ""), token };
}

export class FoodFlowClient {
  private readonly config: FoodFlowConfig;

  constructor(config: FoodFlowConfig) {
    this.config = config;
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await fetch(this.config.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new FoodFlowError(0, "unreachable", `Could not reach FoodFlow at ${this.config.baseUrl}: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const error = json?.error ?? {};
      const issues = Array.isArray(error.issues) ? ` ${JSON.stringify(error.issues).slice(0, 400)}` : "";
      throw new FoodFlowError(res.status, error.code ?? "http_error", `${error.message ?? `HTTP ${res.status}`}${issues}`);
    }
    return { status: res.status, json };
  }

  async whoami(): Promise<Identity> {
    return (await this.request("GET", "/api/household/whoami")).json as Identity;
  }

  /**
   * Refuse to upload to a FoodFlow that can't honor the contract. One that
   * predates external IDs would silently drop them and ingest every re-run
   * as a new receipt, doubling inventory.
   */
  async preflight(): Promise<Identity> {
    const identity = await this.whoami();
    if (!identity.scopes?.includes("ingest")) {
      throw new FoodFlowError(403, "forbidden_scope", `FoodFlow client "${identity.clientName}" lacks the ingest scope.`);
    }
    if ((identity.receiptContractVersion ?? 0) < CONTRACT_VERSION) {
      throw new FoodFlowError(
        0,
        "contract_unsupported",
        `This FoodFlow speaks receipt contract v${identity.receiptContractVersion ?? 0}; records are v${CONTRACT_VERSION}. ` +
          "Update FoodFlow before uploading."
      );
    }
    return identity;
  }

  async uploadReceipt(record: ReceiptRecord): Promise<UploadResult> {
    const { json } = await this.request("POST", "/api/household/receipts", toUploadBody(record));
    const receipt = json?.receipt ?? {};
    if (receipt.externalId !== record.externalId || receipt.externalSource !== record.externalSource) {
      throw new FoodFlowError(
        0,
        "contract_unsupported",
        `FoodFlow stored receipt ${receipt.id} without the external ID that was sent. Stopping so re-runs can't duplicate it.`
      );
    }
    return {
      receiptId: receipt.id,
      duplicate: json.duplicate === true,
      parseStatus: receipt.parseStatus,
      itemCount: Array.isArray(receipt.items) ? receipt.items.length : 0,
      reconciled: json.reconciliation?.reconciled ?? null,
      differenceCents: json.reconciliation?.differenceCents ?? null,
      probableDuplicateOf: json.probableDuplicateOf ?? null,
    };
  }
}
