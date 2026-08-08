export const LANE_API_ROUTES = [
  { method: "GET", path: "/health", label: "Health" },
  { method: "GET", path: "/v1/models", label: "Models" },
  { method: "POST", path: "/v1/responses", label: "Responses" },
  {
    method: "POST",
    path: "/v1/chat/completions",
    label: "Chat Completions",
  },
  {
    method: "POST",
    path: "/v1/images/generations",
    label: "Image Generations",
  },
] as const;

export type LaneApiPath = (typeof LANE_API_ROUTES)[number]["path"];

export function getLaneApiBaseUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/v1`;
}

export function getLaneApiUrl(endpoint: string, path: LaneApiPath): string {
  return `${endpoint.replace(/\/+$/, "")}${path}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface LaneCurlDefaults {
  defaultModel?: string;
  defaultImageModel?: string;
}

function withModel(model: string | undefined, body: object): object {
  return model ? { model, ...body } : body;
}

function requestBodyForPath(
  path: LaneApiPath,
  defaults: LaneCurlDefaults,
): object | undefined {
  switch (path) {
    case "/v1/images/generations":
      return withModel(defaults.defaultImageModel, {
        prompt: "A quiet road at sunrise.",
      });
    case "/v1/responses":
      return withModel(defaults.defaultModel, {
        input: "Say hello in one sentence.",
      });
    case "/v1/chat/completions":
      return withModel(defaults.defaultModel, {
        messages: [{ role: "user", content: "Say hello in one sentence." }],
      });
    default:
      return undefined;
  }
}

export function buildLaneEndpointCurl(
  endpoint: string,
  path: LaneApiPath,
  clientKey: string,
  defaults: LaneCurlDefaults = {},
): string {
  const url = getLaneApiUrl(endpoint, path);
  const body = requestBodyForPath(path, defaults);
  if (!body) {
    return [
      `curl --fail-with-body ${shellQuote(url)} \\`,
      `  -H ${shellQuote(`Authorization: Bearer ${clientKey}`)}`,
    ].join("\n");
  }

  return [
    `curl --fail-with-body --request POST ${shellQuote(url)} \\`,
    `  -H ${shellQuote(`Authorization: Bearer ${clientKey}`)} \\`,
    `  -H ${shellQuote("Content-Type: application/json")} \\`,
    `  --data ${shellQuote(JSON.stringify(body))}`,
  ].join("\n");
}
