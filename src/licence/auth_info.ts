/**
 * AuthInfoV2 — license authorization info, serialized as JSON inside the licence.
 * Compatible with Python licence_codec.AuthInfoV2.
 * The client (Rust) AuthInfo struct is a subset; extra fields like max_app_major are
 * ignored by the client's manual JSON parsing.
 */

export interface AuthInfoV2 {
  version: string;
  start_time: number;
  valid_day: number;
  product_id: string;
  edition: string;
  tier: string;
  features: string[];
  max_app_major: number;
}

export function createAuthInfo(params: {
  productId: string;
  edition: string;
  tier: string;
  features: string[];
  maxAppMajor: number;
  validDay?: number;
}): AuthInfoV2 {
  return {
    version: "2",
    start_time: Math.floor(Date.now() / 1000),
    valid_day: params.validDay ?? 0,
    product_id: params.productId,
    edition: params.edition,
    tier: params.tier,
    features: params.features,
    max_app_major: params.maxAppMajor,
  };
}

export function authInfoToJson(auth: AuthInfoV2): string {
  return JSON.stringify(auth);
}

export function authInfoFromJson(json: string): AuthInfoV2 {
  return JSON.parse(json) as AuthInfoV2;
}
