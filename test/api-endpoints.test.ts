import { describe, expect, it } from "vitest";

import {
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
      "http://127.0.0.1:3210/v1/images/generations",
      "http://127.0.0.1:3210/v1/responses",
      "http://127.0.0.1:3210/v1/chat/completions",
    ]);
  });
});
