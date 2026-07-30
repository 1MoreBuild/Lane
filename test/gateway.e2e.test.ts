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
import { PiAiRuntime } from "../src/main/pi-runtime.ts";
import type { ProviderConfig } from "../src/shared/contracts.ts";
import { freePort } from "./helpers.ts";
import { startMockOpenAI, type MockOpenAI } from "./mock-openai.ts";

const clientKey = "lane-e2e-client-key";
const resources: Array<{ gateway: GatewayServer; upstream: MockOpenAI }> = [];

async function setup() {
  const upstream = await startMockOpenAI();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("mock", async () => ({ type: "api_key", key: "mock-upstream-key" }));
  const model: Model<"openai-completions"> = {
    id: "mock-model",
    name: "Mock Model",
    api: "openai-completions",
    provider: "mock",
    baseUrl: upstream.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
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
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  const config: ProviderConfig = {
    id: "mock",
    kind: "custom-openai",
    name: "Mock",
    baseUrl: upstream.baseUrl,
    models: ["mock-model", "mock-image"],
    createdAt: 1,
  };
  const imageRuntime = new PiAiImageRuntime(
    buildImageModels([config], credentials),
    [config],
    "mock/mock-image",
  );
  const gateway = new GatewayServer(
    new PiAiRuntime(models, [config], "mock/mock-model", imageRuntime),
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
  return { upstream, gateway, url: `http://127.0.0.1:${port}` };
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
    const { url, upstream } = await setup();
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
