export const LANE_NATIVE_HOST_NAME = "works.earendil.lane";
export const LANE_NATIVE_PROTOCOL_VERSION = 1;
export const TRANSLY_PRODUCTION_EXTENSION_ID = "mdjfkiddlpdgchddcckhcmdjekmmhcgp";
export const TRANSLY_PRODUCTION_EXTENSION_ORIGIN =
  `chrome-extension://${TRANSLY_PRODUCTION_EXTENSION_ID}`;
export const TRANSLY_PRODUCTION_NATIVE_ALLOWED_ORIGIN =
  `${TRANSLY_PRODUCTION_EXTENSION_ORIGIN}/`;

// This is an explicit allowlist, never a wildcard. The production ID is
// derived from Transly's verified Chrome Web Store public key. The same key is
// checked into Transly's manifest, so unpacked and store builds use this ID.
export const TRANSLY_EXTENSION_ORIGINS = [TRANSLY_PRODUCTION_EXTENSION_ORIGIN] as const;
export const TRANSLY_NATIVE_ALLOWED_ORIGINS = [
  TRANSLY_PRODUCTION_NATIVE_ALLOWED_ORIGIN,
] as const;

export function isAllowedTranslyExtensionOrigin(value: string): boolean {
  const origin = value.endsWith("/") ? value.slice(0, -1) : value;
  return (TRANSLY_EXTENSION_ORIGINS as readonly string[]).includes(origin);
}

export interface LaneNativeConnectRequest {
  protocolVersion: typeof LANE_NATIVE_PROTOCOL_VERSION;
  type: "connect";
}

export interface LaneNativeConnection {
  service: "lane";
  apiUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string | null;
  protocol: "responses";
}

export type LaneNativeResponse =
  | {
      protocolVersion: typeof LANE_NATIVE_PROTOCOL_VERSION;
      ok: true;
      data: LaneNativeConnection;
    }
  | {
      protocolVersion: typeof LANE_NATIVE_PROTOCOL_VERSION;
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };
