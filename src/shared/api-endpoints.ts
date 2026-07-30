export const LANE_API_ROUTES = [
  { method: "GET", path: "/health", label: "Health" },
  { method: "GET", path: "/v1/models", label: "Models" },
  {
    method: "POST",
    path: "/v1/images/generations",
    label: "Image Generations",
  },
  { method: "POST", path: "/v1/responses", label: "Responses" },
  {
    method: "POST",
    path: "/v1/chat/completions",
    label: "Chat Completions",
  },
] as const;

export type LaneApiPath = (typeof LANE_API_ROUTES)[number]["path"];

export function getLaneApiBaseUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/v1`;
}

export function getLaneApiUrl(endpoint: string, path: LaneApiPath): string {
  return `${endpoint.replace(/\/+$/, "")}${path}`;
}
