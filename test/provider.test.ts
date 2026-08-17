import {
  createModels,
  createProvider,
  InMemoryCredentialStore,
  type ImagesModel,
  type OAuthCredential,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { discoverModels, normalizeModels } from "../src/main/model-discovery.ts";
import { buildModels, mapProviderError } from "../src/main/pi-runtime.ts";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  buildImageModels,
  createOpenAiImagesProvider,
  PiAiImageRuntime,
} from "../src/main/image-runtime.ts";

const unusedStreams: ProviderStreams = {
  stream: () => {
    throw new Error("not used");
  },
  streamSimple: () => {
    throw new Error("not used");
  },
};

describe("provider connections", () => {
  it("normalizes, deduplicates, and sorts model lists", () => {
    expect(
      normalizeModels({
        data: [
          { id: "z-model", name: "Z" },
          { id: "a-model", display_name: "A" },
          { id: "a-model", name: "A2" },
          { nope: true },
        ],
      }),
    ).toEqual([
      { id: "a-model", name: "A2" },
      { id: "z-model", name: "Z" },
    ]);
  });

  it.each([
    ["openai", "https://api.openai.com/v1/models", "Authorization"],
    ["openrouter", "https://openrouter.ai/api/v1/models", "Authorization"],
    ["anthropic", "https://api.anthropic.com/v1/models", "x-api-key"],
    ["custom-openai", "http://127.0.0.1:9999/v1/models", "Authorization"],
  ] as const)("loads %s models without a generation request", async (kind, url, header) => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(url);
      expect(new Headers(init?.headers).has(header)).toBe(true);
      return new Response(JSON.stringify({ data: [{ id: "model-1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const models = await discoverModels(
      {
        kind,
        apiKey: "test-secret",
        ...(kind === "custom-openai" ? { baseUrl: "http://127.0.0.1:9999/v1" } : {}),
      },
      fetcher,
    );
    expect(models).toEqual([{ id: "model-1", name: "model-1" }]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("gives model discovery a deadline when the caller supplies no signal", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return new Response(JSON.stringify({ data: [{ id: "model-1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await discoverModels({ kind: "openai", apiKey: "test-secret" }, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("aborts model discovery when the upstream host stalls", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
          controller.abort();
        }),
    );
    const pending = discoverModels(
      { kind: "openai", apiKey: "test-secret" },
      fetcher,
      controller.signal,
    );
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("marks configured custom OpenAI-compatible models as image-capable", () => {
    const models = buildModels(
      [
        {
          id: "custom",
          kind: "custom-openai",
          name: "Custom",
          baseUrl: "http://127.0.0.1:9999/v1",
          models: ["vision-model"],
          createdAt: 1,
        },
      ],
      new InMemoryCredentialStore(),
    );

    expect(models.getModel("custom", "vision-model")?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("refreshes an expired OAuth token under the credential store", async () => {
    const credentials = new InMemoryCredentialStore();
    const expired: OAuthCredential = {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    };
    await credentials.modify("oauth-test", async () => expired);
    let refreshCount = 0;
    const provider = createProvider({
      id: "oauth-test",
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async () => expired,
          refresh: async () => {
            refreshCount += 1;
            return {
              type: "oauth",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60_000,
            };
          },
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: [
        {
          id: "model",
          name: "Model",
          provider: "oauth-test",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 100,
        },
      ],
      api: unusedStreams,
    });
    const models = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    models.setProvider(provider);
    const [auth, concurrentAuth] = await Promise.all([
      models.getAuth("oauth-test"),
      models.getAuth("oauth-test"),
    ]);
    expect(auth?.auth.apiKey).toBe("new-access");
    expect(concurrentAuth?.auth.apiKey).toBe("new-access");
    expect(refreshCount).toBe(1);
    expect((await credentials.read("oauth-test") as OAuthCredential).refresh).toBe("new-refresh");
  });

  it("maps provider failures without leaking raw upstream text", () => {
    expect(mapProviderError("429 quota exhausted", "error")).toMatchObject({
      status: 429,
      code: "provider_rate_limit",
    });
    expect(mapProviderError("request timed out", "error")).toMatchObject({
      status: 504,
      code: "provider_timeout",
    });
    expect(mapProviderError("invalid API key sk-secretvalue", "error")).toMatchObject({
      status: 502,
      code: "provider_authentication_error",
      message: "Provider authentication failed",
    });
    expect(mapProviderError("secret echoed by upstream", "error").message).toBe(
      "Provider request failed",
    );
  });

  it("loads the provider-owned ChatGPT OAuth refresh implementation without real network", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
      }),
    ).toString("base64url");
    const access = `eyJhbGciOiJub25lIn0.${payload}.signature`;
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          access_token: access,
          refresh_token: "refreshed-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const oauth = openaiCodexProvider().auth.oauth;
      expect(oauth).toBeDefined();
      const refreshed = await oauth!.refresh({
        type: "oauth",
        access: "expired-access",
        refresh: "test-refresh",
        expires: 0,
      });
      expect(refreshed).toMatchObject({
        access,
        refresh: "refreshed-token",
        accountId: "account-test",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exposes Codex and OpenAI image models through pi-ai ImagesModels", () => {
    const credentials = new InMemoryCredentialStore();
    const images = buildImageModels(
      [
        {
          id: "openai-codex",
          kind: "openai-codex",
          name: "ChatGPT / Codex",
          models: [],
          createdAt: 1,
        },
        {
          id: "openai",
          kind: "openai",
          name: "OpenAI",
          models: ["gpt-5.6", "gpt-image-2"],
          createdAt: 1,
        },
      ],
      credentials,
    );
    expect(images.getModel("openai-codex", "gpt-image-2")?.name).toBe(
      "GPT Image 2",
    );
    expect(images.getModel("openai", "gpt-image-2")?.name).toBe("GPT Image 2");
  });

  it("uses Codex OAuth headers for image generation without a real request", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-image" },
      }),
    ).toString("base64url");
    const access = `eyJhbGciOiJub25lIn0.${payload}.signature`;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://chatgpt.com/backend-api/codex/images/generations",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${access}`);
      expect(headers.get("chatgpt-account-id")).toBe("account-image");
      expect(headers.get("originator")).toBe("lane");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-image-2",
        prompt: "draw a clean road",
        quality: "low",
      });
      return new Response(
        JSON.stringify({
          output_format: "png",
          data: [{ b64_json: "aW1hZ2U=", revised_prompt: "clean road" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const model: ImagesModel<"openai-images"> = {
      id: "gpt-image-2",
      name: "GPT Image 2",
      api: "openai-images",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"],
      output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const provider = createOpenAiImagesProvider(
      {
        id: "openai-codex",
        name: "ChatGPT / Codex",
        baseUrl: model.baseUrl,
        models: [model],
        auth: openaiCodexProvider().auth,
        codexOAuth: true,
      },
      fetcher,
    );
    const result = await provider.generateImages(
      model,
      { input: [{ type: "text", text: "draw a clean road" }] },
      {
        apiKey: access,
        metadata: { laneImageOptions: { quality: "low" } },
      },
    );
    expect(result.stopReason).toBe("stop");
    expect(result.output).toEqual([
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "text", text: "clean road" },
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects transparent backgrounds for gpt-image-2 before an upstream request", async () => {
    const credentials = new InMemoryCredentialStore();
    const configs = [
      {
        id: "openai-codex",
        kind: "openai-codex" as const,
        name: "ChatGPT / Codex",
        models: [],
        createdAt: 1,
      },
    ];
    const runtime = new PiAiImageRuntime(
      buildImageModels(configs, credentials),
      configs,
      "openai-codex/gpt-image-2",
    );

    await expect(
      runtime.generate(
        {
          prompt: "draw a clean road",
          background: "transparent",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "unsupported_parameter",
    });
  });

  it("keeps native transparency available for gpt-image-1.5", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-image-1.5",
        background: "transparent",
        output_format: "png",
      });
      return new Response(
        JSON.stringify({
          output_format: "png",
          data: [{ b64_json: "aW1hZ2U=" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const model: ImagesModel<"openai-images"> = {
      id: "gpt-image-1.5",
      name: "GPT Image 1.5",
      api: "openai-images",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      input: ["text"],
      output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const provider = createOpenAiImagesProvider(
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: model.baseUrl,
        models: [model],
        auth: openaiProvider().auth,
      },
      fetcher,
    );
    const result = await provider.generateImages(
      model,
      { input: [{ type: "text", text: "draw a clean road" }] },
      {
        apiKey: "test-key",
        metadata: {
          laneImageOptions: {
            background: "transparent",
            outputFormat: "png",
          },
        },
      },
    );

    expect(result.stopReason).toBe("stop");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
