import {
  createImagesModels,
  createImagesProvider,
  envApiKeyAuth,
  type AssistantImages,
  type CredentialStore,
  type ImagesApi,
  type ImagesContext,
  type ImagesModel,
  type ImagesModels,
  type ImagesOptions,
  type MutableImagesModels,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterImagesProvider } from "@earendil-works/pi-ai/providers/openrouter-images";
import type { ProviderConfig, PublicModel } from "../shared/contracts.ts";
import type {
  CanonicalImageRequest,
  CanonicalImageResult,
} from "./runtime.ts";
import { RuntimeError } from "./runtime.ts";
import { mapProviderError } from "./pi-runtime.ts";

const OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const CODEX_IMAGE_BASE_URL = "https://chatgpt.com/backend-api/codex";
const MAX_IMAGE_RESPONSE_BYTES = 128 * 1024 * 1024;
const GPT_IMAGE_2_PATTERN = /^gpt-image-2(?:-|$)/;

// Image endpoints answer chunked, so Content-Length cannot bound the download.
// Reading incrementally stops a hostile base URL from exhausting main-process
// memory before the size can be checked.
async function boundedText(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Image provider response is too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const OPENAI_IMAGE_MODELS = [
  ["gpt-image-2", "GPT Image 2"],
  ["gpt-image-1.5", "GPT Image 1.5"],
  ["gpt-image-1", "GPT Image 1"],
  ["gpt-image-1-mini", "GPT Image 1 Mini"],
] as const;

interface ImageRequestOptions {
  n?: number;
  quality?: CanonicalImageRequest["quality"];
  size?: string;
  background?: CanonicalImageRequest["background"];
  outputFormat?: CanonicalImageRequest["outputFormat"];
  outputCompression?: number;
  moderation?: CanonicalImageRequest["moderation"];
  user?: string;
}

interface OpenAiImageResponse {
  created?: number;
  output_format?: string;
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
}

function imageModel(
  provider: string,
  id: string,
  name: string,
  baseUrl: string,
): ImagesModel<ImagesApi> {
  return {
    id,
    name,
    api: "openai-images",
    provider,
    baseUrl,
    input: ["text"],
    output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function accountIdFromAccessToken(token: string): string {
  try {
    const payload = token.split(".")[1];
    if (!payload) throw new Error("Invalid token");
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const accountId =
      parsed["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("Missing account");
    return accountId;
  } catch {
    throw new Error("Failed to read ChatGPT account from OAuth token");
  }
}

function applyHeaders(headers: Headers, values?: ProviderHeaders): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
}

function headersRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function mimeType(format: string | undefined): string {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function textPrompt(context: ImagesContext): string {
  const prompt = context.input
    .filter((item): item is Extract<(typeof context.input)[number], { type: "text" }> =>
      item.type === "text",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!prompt) throw new Error("Image prompt is required");
  return prompt;
}

export function createOpenAiImagesProvider(
  input: {
    id: string;
    name: string;
    baseUrl: string;
    models: readonly ImagesModel<ImagesApi>[];
    auth: ReturnType<typeof openaiProvider>["auth"];
    codexOAuth?: boolean;
  },
  fetcher: typeof fetch = fetch,
) {
  return createImagesProvider({
    ...input,
    api: {
      generateImages: async (
        model: ImagesModel<ImagesApi>,
        context: ImagesContext,
        options?: ImagesOptions,
      ): Promise<AssistantImages> => {
        const output: AssistantImages = {
          api: model.api,
          provider: model.provider,
          model: model.id,
          output: [],
          stopReason: "stop",
          timestamp: Date.now(),
        };
        try {
          if (!options?.apiKey) {
            throw new Error(`No API key for provider: ${model.provider}`);
          }
          const requestOptions =
            (options.metadata?.laneImageOptions as ImageRequestOptions | undefined) ?? {};
          let body: Record<string, unknown> = {
            model: model.id,
            prompt: textPrompt(context),
            ...(requestOptions.n !== undefined ? { n: requestOptions.n } : {}),
            ...(requestOptions.quality ? { quality: requestOptions.quality } : {}),
            ...(requestOptions.size ? { size: requestOptions.size } : {}),
            ...(requestOptions.background
              ? { background: requestOptions.background }
              : {}),
            ...(requestOptions.outputFormat
              ? { output_format: requestOptions.outputFormat }
              : {}),
            ...(requestOptions.outputCompression !== undefined
              ? { output_compression: requestOptions.outputCompression }
              : {}),
            ...(requestOptions.moderation
              ? { moderation: requestOptions.moderation }
              : {}),
            ...(requestOptions.user ? { user: requestOptions.user } : {}),
          };
          const replacement = await options.onPayload?.(body, model);
          if (replacement !== undefined) body = replacement as Record<string, unknown>;

          const headers = new Headers({
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          });
          applyHeaders(headers, model.headers);
          applyHeaders(headers, options.headers);
          if (input.codexOAuth) {
            headers.set("chatgpt-account-id", accountIdFromAccessToken(options.apiKey));
            headers.set("originator", "lane");
          }

          const response = await fetcher(
            `${model.baseUrl.replace(/\/+$/, "")}/images/generations`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              ...(options.signal ? { signal: options.signal } : {}),
            },
          );
          await options.onResponse?.(
            { status: response.status, headers: headersRecord(response.headers) },
            model,
          );
          const declaredSize = Number(response.headers.get("content-length") ?? 0);
          if (declaredSize > MAX_IMAGE_RESPONSE_BYTES) {
            throw new Error("Image provider response is too large");
          }
          const raw = await boundedText(response, MAX_IMAGE_RESPONSE_BYTES);
          let payload: OpenAiImageResponse & {
            error?: { message?: unknown; code?: unknown };
          };
          try {
            payload = JSON.parse(raw) as typeof payload;
          } catch {
            throw new Error(`Image provider returned invalid JSON (${response.status})`);
          }
          if (!response.ok) {
            const message =
              typeof payload.error?.message === "string"
                ? payload.error.message
                : `Image provider request failed (${response.status})`;
            throw new Error(`${response.status}: ${message}`);
          }
          const format =
            payload.output_format ?? requestOptions.outputFormat ?? "png";
          for (const item of payload.data ?? []) {
            if (typeof item.b64_json !== "string" || !item.b64_json) continue;
            output.output.push({
              type: "image",
              data: item.b64_json,
              mimeType: mimeType(format),
            });
            if (typeof item.revised_prompt === "string" && item.revised_prompt) {
              output.output.push({ type: "text", text: item.revised_prompt });
            }
          }
          if (!output.output.some((item) => item.type === "image")) {
            throw new Error("Image provider returned no image data");
          }
          const responseId = response.headers.get("x-request-id");
          if (responseId) output.responseId = responseId;
          return output;
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = error instanceof Error ? error.message : String(error);
          return output;
        }
      },
    },
  });
}

function knownImageModelIds(config: ProviderConfig): Set<string> {
  return new Set(
    config.models.filter((id) =>
      /(^|[/.-])(?:gpt-)?image(?:$|[/.-])|seedream|flux|nano-banana/i.test(id),
    ),
  );
}

export function buildImageModels(
  configs: readonly ProviderConfig[],
  credentials: CredentialStore,
): MutableImagesModels {
  const models = createImagesModels({
    credentials,
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });
  for (const config of configs) {
    if (config.kind === "openai-codex") {
      const provider = openaiCodexProvider();
      models.setProvider(
        createOpenAiImagesProvider({
          id: config.id,
          name: config.name,
          baseUrl: CODEX_IMAGE_BASE_URL,
          models: [
            imageModel(config.id, "gpt-image-2", "GPT Image 2", CODEX_IMAGE_BASE_URL),
          ],
          auth: provider.auth,
          codexOAuth: true,
        }),
      );
    } else if (config.kind === "openai") {
      const provider = openaiProvider();
      models.setProvider(
        createOpenAiImagesProvider({
          id: config.id,
          name: config.name,
          baseUrl: OPENAI_IMAGE_BASE_URL,
          models: OPENAI_IMAGE_MODELS.map(([id, name]) =>
            imageModel(config.id, id, name, OPENAI_IMAGE_BASE_URL),
          ),
          auth: provider.auth,
        }),
      );
    } else if (config.kind === "openrouter") {
      models.setProvider(openrouterImagesProvider());
    } else if (config.kind === "custom-openai") {
      const ids = [...knownImageModelIds(config)];
      if (ids.length === 0) continue;
      const baseUrl = config.baseUrl ?? "";
      models.setProvider(
        createOpenAiImagesProvider({
          id: config.id,
          name: config.name,
          baseUrl,
          models: ids.map((id) => imageModel(config.id, id, id, baseUrl)),
          auth: { apiKey: envApiKeyAuth(`${config.name} API key`, []) },
        }),
      );
    }
  }
  return models;
}

function publicImageModels(
  models: ImagesModels,
  configs: readonly ProviderConfig[],
): PublicModel[] {
  const result: PublicModel[] = [];
  for (const config of configs) {
    const discovered = new Set(config.models);
    for (const model of models.getModels(config.id)) {
      if (
        config.kind !== "openai-codex" &&
        discovered.size > 0 &&
        !discovered.has(model.id)
      ) {
        continue;
      }
      result.push({
        id: `${config.id}/${model.id}`,
        provider: config.id,
        name: model.name,
      });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export class PiAiImageRuntime {
  constructor(
    private readonly models: ImagesModels,
    private readonly configs: readonly ProviderConfig[],
    private readonly defaultModel?: string,
  ) {}

  listModels(): PublicModel[] {
    return publicImageModels(this.models, this.configs);
  }

  private resolveModel(requested?: string): ImagesModel<ImagesApi> {
    const id = requested || this.defaultModel;
    if (!id) throw new RuntimeError("No image model selected", 400, "image_model_required");
    const separator = id.indexOf("/");
    if (separator > 0) {
      const model = this.models.getModel(id.slice(0, separator), id.slice(separator + 1));
      if (model) return model;
    }
    const matches = this.models.getModels().filter((model) => model.id === id);
    if (matches.length === 1) return matches[0]!;
    throw new RuntimeError(`Unknown or ambiguous image model: ${id}`, 404, "model_not_found");
  }

  async generate(
    request: CanonicalImageRequest,
    signal: AbortSignal,
  ): Promise<CanonicalImageResult> {
    const model = this.resolveModel(request.model);
    if (
      request.background === "transparent" &&
      GPT_IMAGE_2_PATTERN.test(model.id)
    ) {
      throw new RuntimeError(
        "gpt-image-2 does not support transparent backgrounds; use auto, opaque, or a transparency-capable image model",
        400,
        "unsupported_parameter",
      );
    }
    const result = await this.models.generateImages(
      model,
      { input: [{ type: "text", text: request.prompt }] },
      {
        signal,
        maxRetries: 0,
        metadata: {
          laneImageOptions: {
            ...(request.n !== undefined ? { n: request.n } : {}),
            ...(request.quality ? { quality: request.quality } : {}),
            ...(request.size ? { size: request.size } : {}),
            ...(request.background ? { background: request.background } : {}),
            ...(request.outputFormat ? { outputFormat: request.outputFormat } : {}),
            ...(request.outputCompression !== undefined
              ? { outputCompression: request.outputCompression }
              : {}),
            ...(request.moderation ? { moderation: request.moderation } : {}),
            ...(request.user ? { user: request.user } : {}),
          } satisfies ImageRequestOptions,
        },
      },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw mapProviderError(
        result.errorMessage ?? "Image provider request failed",
        result.stopReason,
      );
    }
    // The provider flattens each image and its own revised prompt into adjacent
    // entries, so the text right after an image is the one describing it.
    const images = result.output.flatMap((item, index) => {
      if (item.type !== "image") return [];
      const next = result.output[index + 1];
      const revisedPrompt = next?.type === "text" ? next.text : undefined;
      return [
        {
          b64Json: item.data,
          mimeType: item.mimeType,
          ...(revisedPrompt ? { revisedPrompt } : {}),
        },
      ];
    });
    if (images.length === 0) {
      throw new RuntimeError("Image provider returned no image data");
    }
    return {
      model: `${model.provider}/${model.id}`,
      created: Math.floor(Date.now() / 1000),
      images,
    };
  }
}
