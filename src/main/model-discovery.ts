import type { ProviderKind } from "../shared/contracts.ts";
import { assertSafeUpstreamUrl } from "./security.ts";

export interface DiscoveredModel {
  id: string;
  name: string;
}

export interface DiscoveryInput {
  kind: Exclude<ProviderKind, "openai-codex">;
  apiKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URLS: Record<Exclude<ProviderKind, "openai-codex" | "custom-openai">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export function normalizeModels(payload: unknown): DiscoveredModel[] {
  if (!payload || typeof payload !== "object") throw new Error("Provider returned invalid model data");
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("Provider model response is missing data[]");
  const unique = new Map<string, DiscoveredModel>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    const name = (item as { name?: unknown; display_name?: unknown }).name;
    const displayName = (item as { display_name?: unknown }).display_name;
    if (typeof id !== "string" || id.trim().length === 0) continue;
    unique.set(id, {
      id,
      name:
        typeof name === "string"
          ? name
          : typeof displayName === "string"
            ? displayName
            : id,
    });
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const DISCOVERY_TIMEOUT_MS = 30_000;

export async function discoverModels(
  input: DiscoveryInput,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  if (!input.apiKey.trim()) throw new Error("API key is required");
  const rawBase =
    input.kind === "custom-openai"
      ? input.baseUrl
      : DEFAULT_BASE_URLS[input.kind];
  if (!rawBase) throw new Error("Custom provider base URL is required");
  const base = assertSafeUpstreamUrl(rawBase);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> =
    input.kind === "anthropic"
      ? {
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        }
      : { Authorization: `Bearer ${input.apiKey}` };
  // No caller supplies a signal today, so without a deadline a base URL that
  // completes its handshake and then stalls leaves the connect flow hanging.
  const response = await fetcher(base, {
    headers,
    signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Provider model request failed (${response.status})`);
  }
  const models = normalizeModels(await response.json());
  if (models.length === 0) throw new Error("Provider returned no usable models");
  return models;
}
