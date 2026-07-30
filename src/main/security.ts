import { timingSafeEqual } from "node:crypto";

export const LOOPBACK_HOST = "127.0.0.1";

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function assertSafeUpstreamUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error("Remote provider endpoints must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Provider URL must not contain credentials");
  if (url.search || url.hash) throw new Error("Provider URL must not contain a query or fragment");
  return url;
}

export function assertSafeOAuthAuthorizationUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("OAuth authorization URL must use HTTPS");
  const redirect = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  if (!redirect) throw new Error("OAuth URL is missing redirect_uri");
  const redirectUrl = new URL(redirect);
  if (redirectUrl.protocol !== "http:" || !isLoopbackHostname(redirectUrl.hostname)) {
    throw new Error("OAuth redirect must use a loopback HTTP callback");
  }
  if (!state || state.length < 16) throw new Error("OAuth URL is missing a strong state value");
  if (!challenge || url.searchParams.get("code_challenge_method") !== "S256") {
    throw new Error("OAuth URL must use PKCE S256");
  }
  return url;
}

export function constantTimeKeyEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function extractClientKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const authorization = headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (value?.startsWith("Bearer ")) return value.slice(7);
  const laneKey = headers["x-lane-key"];
  return Array.isArray(laneKey) ? laneKey[0] : laneKey;
}
