import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayServer } from "../src/main/gateway.ts";
import { buildImageModels, PiAiImageRuntime } from "../src/main/image-runtime.ts";
import { LaneLogger } from "../src/main/logger.ts";
import { PiAiRuntime } from "../src/main/pi-runtime.ts";
import type { ProviderConfig, ReasoningEffort } from "../src/shared/contracts.ts";
import { freePort } from "./helpers.ts";
import { startMockOpenAI, type MockOpenAI } from "./mock-openai.ts";

const clientKey = "lane-e2e-client-key";
const resources: Array<{ gateway: GatewayServer; upstream: MockOpenAI }> = [];

async function setup(options: {
  runtimeKind?: ProviderConfig["kind"];
  defaultReasoningEffort?: ReasoningEffort;
  defaultSpeedMode?: "standard" | "fast";
  includeLimitedReasoningModel?: boolean;
} = {}) {
  const upstream = await startMockOpenAI();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("mock", async () => ({ type: "api_key", key: "mock-upstream-key" }));
  const model: Model<"openai-completions"> = {
    id: "mock-model",
    name: "Mock Model",
    api: "openai-completions",
    provider: "mock",
    baseUrl: upstream.baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
    thinkingLevelMap: {
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  };
  const limitedModel: Model<"openai-completions"> = {
    ...model,
    id: "mock-limited",
    name: "Mock Limited Model",
    thinkingLevelMap: {
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
  };
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(
    createProvider({
      id: "mock",
      name: "Mock",
      baseUrl: upstream.baseUrl,
      auth: { apiKey: envApiKeyAuth("Mock key", []) },
      models: options.includeLimitedReasoningModel ? [model, limitedModel] : [model],
      api: openAICompletionsApi(),
    }),
  );
  const config: ProviderConfig = {
    id: "mock",
    kind: "custom-openai",
    name: "Mock",
    baseUrl: upstream.baseUrl,
    models: [
      "mock-model",
      ...(options.includeLimitedReasoningModel ? ["mock-limited"] : []),
      "mock-image",
    ],
    createdAt: 1,
  };
  const imageRuntime = new PiAiImageRuntime(
    buildImageModels([config], credentials),
    [config],
    "mock/mock-image",
  );
  const logger = new LaneLogger();
  const gateway = new GatewayServer(
    new PiAiRuntime(
      models,
      [{ ...config, kind: options.runtimeKind ?? "openai" }],
      "mock/mock-model",
      imageRuntime,
      options.defaultReasoningEffort,
      options.defaultSpeedMode,
    ),
    logger,
  );
  const port = await freePort();
  await gateway.start(
    {
      port,
      autoStart: false,
      allowedOrigins: [`http://127.0.0.1:${port}`],
    },
    clientKey,
  );
  resources.push({ gateway, upstream });
  return { upstream, gateway, logger, url: `http://127.0.0.1:${port}` };
}

function headers() {
  return {
    Authorization: `Bearer ${clientKey}`,
    "Content-Type": "application/json",
  };
}

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()!;
    await resource.gateway.stop();
    await resource.upstream.close();
  }
});

describe("gateway with a local pi-ai mock provider", () => {
  it("records redacted correlated request traces with model usage", async () => {
    const { url, logger } = await setup();
    const secretPrompt = "trace-secret-prompt";
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "mock/mock-model", input: secretPrompt }),
    });
    expect(response.status).toBe(200);
    await response.json();

    const traces = logger.list().filter((entry) => entry.trace?.path === "/v1/responses");
    expect(traces).toHaveLength(2);
    expect(traces[0]?.trace).toMatchObject({
      phase: "started",
      method: "POST",
      path: "/v1/responses",
    });
    expect(traces[1]?.trace).toMatchObject({
      phase: "completed",
      method: "POST",
      path: "/v1/responses",
      model: "mock/mock-model",
      provider: "mock",
      status: 200,
      stream: false,
    });
    expect(traces[1]?.trace?.durationMs).toBeGreaterThanOrEqual(0);
    expect(traces[1]?.trace?.inputTokens).toBeTypeOf("number");
    expect(traces[1]?.trace?.outputTokens).toBeTypeOf("number");
    expect(JSON.stringify(logger.list())).not.toContain(secretPrompt);
    expect(JSON.stringify(logger.list())).not.toContain("hello from mock");
    expect(JSON.stringify(logger.list())).not.toContain(clientKey);
  });

  it("serves models and both non-streaming protocols", async () => {
    const { url, upstream } = await setup();
    const models = await fetch(`${url}/v1/models`, { headers: headers() });
    expect(models.status).toBe(200);
    const modelData = (await models.json() as any).data;
    expect(modelData.find((model: any) => model.id === "mock/mock-model")).toMatchObject({
      lane_capabilities: ["chat"],
    });
    expect(modelData.find((model: any) => model.id === "mock/mock-image")).toMatchObject({
      lane_capabilities: ["image_generation"],
    });

    const responses = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "mock/mock-model", input: "hello" }),
    });
    expect(responses.status).toBe(200);
    const responseBody = await responses.json() as any;
    expect(responseBody.output_text).toBe("hello from mock");
    expect(responseBody.status).toBe("completed");

    const chat = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(chat.status).toBe(200);
    expect((await chat.json() as any).choices[0].message.content).toBe("hello from mock");
    expect(upstream.requests.every((request) => request.authorization === "Bearer mock-upstream-key")).toBe(true);
  });

  it("generates images through the OpenAI-compatible endpoint", async () => {
    const { url, upstream } = await setup();
    const response = await fetch(`${url}/v1/images/generations`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        prompt: "draw a lane",
        n: 2,
        quality: "low",
        size: "1024x1024",
        output_format: "webp",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data).toHaveLength(2);
    expect(Buffer.from(body.data[0].b64_json, "base64").toString()).toBe(
      "mock-image-data",
    );
    expect(body.data[0].revised_prompt).toBe("revised: draw a lane");
    expect(
      upstream.requests.find((request) => request.path === "/v1/images/generations"),
    ).toMatchObject({
      authorization: "Bearer mock-upstream-key",
      body: {
        model: "mock-image",
        prompt: "draw a lane",
        n: 2,
        quality: "low",
        size: "1024x1024",
        output_format: "webp",
      },
    });
  });

  it("forwards image inputs and applies configurable default effort", async () => {
    const { url, upstream } = await setup({ defaultReasoningEffort: "xhigh" });
    const dataUrl = "data:image/png;base64,aW1hZ2U=";

    for (const request of [
      {
        path: "/v1/chat/completions",
        body: {
          model: "mock/mock-model",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this" },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        },
      },
      {
        path: "/v1/responses",
        body: {
          model: "mock/mock-model",
          reasoning: { effort: "medium" },
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Describe this" },
                { type: "input_image", image_url: dataUrl },
              ],
            },
          ],
        },
      },
    ]) {
      const response = await fetch(`${url}${request.path}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(200);
    }

    const requests = upstream.requests.filter(
      (request) => request.path === "/v1/chat/completions",
    );
    expect(requests).toHaveLength(2);
    for (const [index, request] of requests.entries()) {
      expect(request.body).toMatchObject({
        reasoning_effort: index === 0 ? "xhigh" : "medium",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      });
    }
  });

  it("clamps saved and request reasoning effort to the resolved model", async () => {
    const { url, upstream } = await setup({
      defaultReasoningEffort: "max",
      includeLimitedReasoningModel: true,
    });

    for (const body of [
      { input: "Use the full model" },
      { model: "mock/mock-limited", input: "Clamp the saved default" },
      {
        model: "mock/mock-limited",
        input: "Clamp the requested effort",
        reasoning: { effort: "xhigh" },
      },
    ]) {
      const response = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }

    const requests = upstream.requests.filter(
      (request) => request.path === "/v1/chat/completions",
    );
    expect(requests).toHaveLength(3);
    expect(
      requests.map(
        (request) => (request.body as { reasoning_effort?: unknown }).reasoning_effort,
      ),
    ).toEqual(["max", "high", "high"]);
  });

  it("supports only Standard and Fast speed modes", async () => {
    const { url, upstream } = await setup();
    const standard = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ input: "standard" }),
    });
    const fast = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        messages: [{ role: "user", content: "fast" }],
        service_tier: "fast",
      }),
    });
    const auto = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ input: "auto", service_tier: "auto" }),
    });

    expect(standard.status).toBe(200);
    expect(fast.status).toBe(200);
    expect(auto.status).toBe(200);

    const requests = upstream.requests.filter(
      (request) => request.path === "/v1/chat/completions",
    );
    expect(requests.at(-3)?.body).toMatchObject({ service_tier: "default" });
    expect(requests.at(-2)?.body).toMatchObject({ service_tier: "priority" });
    expect(requests.at(-1)?.body).toMatchObject({ service_tier: "default" });
  });

  it("uses Standard safely on other providers unless Fast is explicitly requested", async () => {
    const { url, upstream } = await setup({
      runtimeKind: "custom-openai",
      defaultSpeedMode: "fast",
    });
    const fallback = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ input: "fallback" }),
    });
    const explicitFast = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ input: "fast", service_tier: "fast" }),
    });

    expect(fallback.status).toBe(200);
    expect(explicitFast.status).toBe(400);
    expect((await explicitFast.json() as any).error.code).toBe(
      "unsupported_speed_mode",
    );
    expect(upstream.requests.at(-1)?.body).not.toHaveProperty("service_tier");
  });

  it("streams both Responses and Chat Completions events", async () => {
    const { url } = await setup();
    const responses = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "mock/mock-model", input: "hello", stream: true }),
    });
    const responsesText = await responses.text();
    expect(responsesText).toContain("event: response.created");
    expect(responsesText).toContain("event: response.output_text.delta");
    expect(responsesText).toContain("hello");
    expect(responsesText).toContain("event: response.completed");

    const chat = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });
    const chatText = await chat.text();
    expect(chatText).toContain('"object":"chat.completion.chunk"');
    expect(chatText).toContain("hello");
    expect(chatText).toContain("data: [DONE]");
  });

  it("maps upstream errors and aborts the upstream request when the client disconnects", async () => {
    const { url, upstream, logger } = await setup();
    const failed = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "upstream-error" }],
      }),
    });
    expect(failed.status).toBe(502);
    const failure = await failed.json() as any;
    expect(failure.error.type).toBe("provider_error");
    expect(failure.error.message).toBe("Provider request failed");
    expect(
      logger.list().find((entry) => entry.trace?.errorCode === "provider_error")?.trace,
    ).toMatchObject({ status: 502, phase: "completed" });

    const controller = new AbortController();
    const slow = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      signal: controller.signal,
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "slow-stream" }],
        stream: true,
      }),
    });
    const reader = slow.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(upstream.abortedRequests).toBeGreaterThan(0));
    await vi.waitFor(() =>
      expect(
        logger.list().find((entry) => entry.trace?.cancelled)?.trace,
      ).toMatchObject({
        phase: "completed",
        cancelled: true,
        errorCode: "request_cancelled",
      }),
    );
  }, 15_000);

  it("maps image errors and aborts image generation when the client disconnects", async () => {
    const { url, upstream } = await setup();
    const failed = await fetch(`${url}/v1/images/generations`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ prompt: "upstream-error" }),
    });
    expect(failed.status).toBe(502);
    expect((await failed.json() as any).error.type).toBe("provider_error");

    const controller = new AbortController();
    const pending = fetch(`${url}/v1/images/generations`, {
      method: "POST",
      headers: headers(),
      signal: controller.signal,
      body: JSON.stringify({ prompt: "slow-image" }),
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(upstream.abortedRequests).toBeGreaterThan(0));
  }, 15_000);
});
