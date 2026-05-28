/**
 * Creem API client — license activation, validation, deactivation.
 * Uses fetch directly (no SDK dependency) for Cloudflare Workers compatibility.
 */

export interface CreemLicenseResponse {
  id: string;
  product_id: string;
  status: "active" | "inactive" | "expired" | "disabled";
  key: string;
  activation: number;
  activation_limit: number;
  expires_at: string | null;
  instance?: {
    id: string;
    name: string;
    status: string;
  };
}

export interface CreemConfig {
  apiKey: string;
  testMode: boolean;
}

function baseUrl(testMode: boolean): string {
  return testMode
    ? "https://test-api.creem.io/v1"
    : "https://api.creem.io/v1";
}

export class CreemApiError extends Error {
  statusCode: number;
  creemError: string;

  constructor(statusCode: number, message: string, creemError: string) {
    super(message);
    this.statusCode = statusCode;
    this.creemError = creemError;
    this.name = "CreemApiError";
  }
}

async function creemRequest<T>(
  config: CreemConfig,
  endpoint: string,
  body: Record<string, string>
): Promise<T> {
  const url = `${baseUrl(config.testMode)}${endpoint}`;
  const keyPrefix = config.apiKey ? config.apiKey.substring(0, 10) + "..." : "(empty)";
  console.log("[Creem] Request:", JSON.stringify({ url, keyPrefix, body }));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let errMsg = `Creem API error ${res.status}`;
    let errCode = "CREEM_API_ERROR";
    try {
      const errBody = await res.json() as Record<string, string>;
      errMsg = errBody.message || errMsg;
      errCode = errBody.error || errCode;
      console.error("[Creem] API error:", JSON.stringify({ url, status: res.status, body: errBody }));
    } catch {
      const text = await res.text();
      console.error("[Creem] API error (raw):", JSON.stringify({ url, status: res.status, body: text }));
    }
    throw new CreemApiError(res.status, errMsg, errCode);
  }

  return (await res.json()) as T;
}

export async function creemActivate(
  config: CreemConfig,
  key: string,
  instanceName: string
): Promise<CreemLicenseResponse> {
  return creemRequest<CreemLicenseResponse>(config, "/licenses/activate", {
    key,
    instance_name: instanceName,
  });
}

export async function creemValidate(
  config: CreemConfig,
  key: string,
  instanceId: string
): Promise<CreemLicenseResponse> {
  return creemRequest<CreemLicenseResponse>(config, "/licenses/validate", {
    key,
    instance_id: instanceId,
  });
}

export async function creemDeactivate(
  config: CreemConfig,
  key: string,
  instanceId: string
): Promise<CreemLicenseResponse> {
  return creemRequest<CreemLicenseResponse>(config, "/licenses/deactivate", {
    key,
    instance_id: instanceId,
  });
}

/**
 * Detect whether an order ID is a Creem license key.
 * Returns true for anything that doesn't match the legacy AM- format.
 */
export function isCreemKey(raw: string): boolean {
  const trimmed = raw.trim().toUpperCase();
  return !/^AM-[0-9A-Z]{12}$/.test(trimmed) && trimmed.length > 0;
}
