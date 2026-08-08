import { describe, expect, it } from "vitest";

import {
  buildLaneEndpointCurl,
  getLaneApiBaseUrl,
  getLaneApiUrl,
  LANE_API_ROUTES,
} from "../src/shared/api-endpoints.ts";

describe("Lane API endpoint presentation", () => {
  it("builds the OpenAI-compatible base URL", () => {
    expect(getLaneApiBaseUrl("http://127.0.0.1:3210")).toBe(
      "http://127.0.0.1:3210/v1",
    );
    expect(getLaneApiBaseUrl("http://127.0.0.1:3210/")).toBe(
      "http://127.0.0.1:3210/v1",
    );
  });

  it("exposes every supported route as a full local URL", () => {
    expect(
      LANE_API_ROUTES.map((route) =>
        getLaneApiUrl("http://127.0.0.1:3210/", route.path),
      ),
    ).toEqual([
      "http://127.0.0.1:3210/health",
      "http://127.0.0.1:3210/v1/models",
      "http://127.0.0.1:3210/v1/responses",
      "http://127.0.0.1:3210/v1/chat/completions",
      "http://127.0.0.1:3210/v1/images/generations",
    ]);
  });

  it("builds directly runnable authenticated GET requests", () => {
    expect(
      buildLaneEndpointCurl(
        "http://127.0.0.1:3210/",
        "/v1/models",
        "lane-client-key",
      ),
    ).toBe(
      `curl --fail-with-body 'http://127.0.0.1:3210/v1/models' \\
  -H 'Authorization: Bearer lane-client-key'`,
    );
  });

  it("builds POST requests with representative bodies and selected models", () => {
    const defaults = {
      defaultModel: "openai-codex/gpt-5.6-sol",
      defaultImageModel: "openai-codex/gpt-image-2",
    };
    const responseCurl = buildLaneEndpointCurl(
      "http://127.0.0.1:3210",
      "/v1/responses",
      "lane-client-key",
      defaults,
    );
    expect(responseCurl).toContain("--request POST");
    expect(responseCurl).toContain("'Content-Type: application/json'");
    expect(responseCurl).toContain(
      `'${JSON.stringify({
        model: defaults.defaultModel,
        input: "Say hello in one sentence.",
      })}'`,
    );

    const imageCurl = buildLaneEndpointCurl(
      "http://127.0.0.1:3210",
      "/v1/images/generations",
      "lane-client-key",
      defaults,
    );
    expect(imageCurl).toContain(
      `'${JSON.stringify({
        model: defaults.defaultImageModel,
        prompt: "A quiet road at sunrise.",
      })}'`,
    );

    const chatCurl = buildLaneEndpointCurl(
      "http://127.0.0.1:3210",
      "/v1/chat/completions",
      "lane-client-key",
      defaults,
    );
    expect(chatCurl).toContain(
      `'${JSON.stringify({
        model: defaults.defaultModel,
        messages: [
          { role: "user", content: "Say hello in one sentence." },
        ],
      })}'`,
    );
  });
});
