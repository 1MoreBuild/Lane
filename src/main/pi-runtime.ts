import {
  createModels,
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type Api,
  type Context,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type {
  ProviderConfig,
  PublicModel,
  ReasoningEffort,
  SpeedMode,
} from "../shared/contracts.ts";
import { redact } from "./logger.ts";
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalReasoningEffort,
  ModelRuntime,
} from "./runtime.ts";
import { RuntimeError } from "./runtime.ts";
import type { PiAiImageRuntime } from "./image-runtime.ts";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const REASONING_EFFORT_ORDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<Exclude<CanonicalReasoningEffort, "none">>;

function defaultCustomModel(config: ProviderConfig, id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: config.id,
    baseUrl: config.baseUrl ?? "",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

function effectiveReasoningEffort(
  model: Model<Api>,
  requested: Exclude<CanonicalReasoningEffort, "none">,
): Exclude<CanonicalReasoningEffort, "none"> | undefined {
  const supported = new Set(getSupportedThinkingLevels(model));
  if (supported.has(requested)) return requested;

  const requestedIndex = REASONING_EFFORT_ORDER.indexOf(requested);
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = REASONING_EFFORT_ORDER[index];
    if (candidate && supported.has(candidate)) return candidate;
  }
  for (let index = requestedIndex + 1; index < REASONING_EFFORT_ORDER.length; index += 1) {
    const candidate = REASONING_EFFORT_ORDER[index];
    if (candidate && supported.has(candidate)) return candidate;
  }
  return undefined;
}

export function buildModels(
  configs: readonly ProviderConfig[],
  credentials: CredentialStore,
): MutableModels {
  const models = createModels({
    credentials,
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });
  for (const config of configs) {
    if (config.kind === "openai") models.setProvider(openaiProvider());
    if (config.kind === "anthropic") models.setProvider(anthropicProvider());
    if (config.kind === "openrouter") models.setProvider(openrouterProvider());
    if (config.kind === "openai-codex") models.setProvider(openaiCodexProvider());
    if (config.kind === "custom-openai") {
      models.setProvider(
        createProvider({
          id: config.id,
          name: config.name,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          auth: { apiKey: envApiKeyAuth(`${config.name} API key`, []) },
          models: config.models.map((id) => defaultCustomModel(config, id)),
          api: openAICompletionsApi(),
        }),
      );
    }
  }
  return models;
}

function toAssistant(
  message: Extract<CanonicalMessage, { role: "assistant" }>,
  model: Model<Api>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ...(message.toolCalls ?? []).map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: message.toolCalls?.length ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function toContext(request: CanonicalRequest, model: Model<Api>): Context {
  const messages: Context["messages"] = request.messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", content: message.content, timestamp: Date.now() };
    }
    if (message.role === "assistant") return toAssistant(message, model);
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: [{ type: "text", text: message.content }],
      isError: false,
      timestamp: Date.now(),
    };
  });
  const tools: Tool[] | undefined = request.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool["parameters"],
  }));
  return {
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    messages,
    ...(tools?.length ? { tools } : {}),
  };
}

export function mapProviderError(
  message: string,
  reason: "error" | "aborted",
): RuntimeError {
  if (reason === "aborted") return new RuntimeError("Request aborted", 499, "request_aborted");
  const safe = redact(message);
  if (/auth|api key|unauthori[sz]ed|token|credential/i.test(safe)) {
    return new RuntimeError("Provider authentication failed", 502, "provider_authentication_error");
  }
  if (/rate|429|quota/i.test(safe)) {
    return new RuntimeError("Provider rate limit exceeded", 429, "provider_rate_limit");
  }
  if (/timeout|timed out/i.test(safe)) {
    return new RuntimeError("Provider request timed out", 504, "provider_timeout");
  }
  return new RuntimeError("Provider request failed");
}

function publicModels(models: Models, configs: readonly ProviderConfig[]): PublicModel[] {
  const result: PublicModel[] = [];
  for (const config of configs) {
    const discovered = new Set(config.models);
    for (const model of models.getModels(config.id)) {
      if (config.kind !== "openai-codex" && discovered.size > 0 && !discovered.has(model.id)) {
        continue;
      }
      result.push({
        id: `${config.id}/${model.id}`,
        provider: config.id,
        name: model.name,
        reasoning: model.reasoning,
        ...(model.reasoning
          ? {
              reasoningEfforts: getSupportedThinkingLevels(model).filter(
                (level): level is ReasoningEffort =>
                  level === "low" ||
                  level === "medium" ||
                  level === "high" ||
                  level === "xhigh" ||
                  level === "max",
              ),
            }
          : {}),
      });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export class PiAiRuntime implements ModelRuntime {
  constructor(
    private readonly models: Models,
    private readonly configs: readonly ProviderConfig[],
    private readonly defaultModel?: string,
    private readonly images?: PiAiImageRuntime,
    private readonly defaultReasoningEffort: ReasoningEffort = "high",
    private readonly defaultSpeedMode: SpeedMode = "standard",
  ) {}

  private supportsSpeedMode(providerId: string): boolean {
    const kind = this.configs.find((config) => config.id === providerId)?.kind;
    return kind === "openai" || kind === "openai-codex";
  }

  listModels(): PublicModel[] {
    return publicModels(this.models, this.configs);
  }

  listImageModels(): PublicModel[] {
    return this.images?.listModels() ?? [];
  }

  generateImages(
    request: Parameters<NonNullable<ModelRuntime["generateImages"]>>[0],
    signal: AbortSignal,
  ) {
    if (!this.images) {
      throw new RuntimeError("No image providers are configured", 400, "image_model_required");
    }
    return this.images.generate(request, signal);
  }

  private resolveModel(requested?: string): Model<Api> {
    const id = requested || this.defaultModel;
    if (!id) throw new RuntimeError("No model selected", 400, "model_required");
    const separator = id.indexOf("/");
    if (separator > 0) {
      const provider = id.slice(0, separator);
      const modelId = id.slice(separator + 1);
      const model = this.models.getModel(provider, modelId);
      if (model) return model;
    }
    const matches = this.models.getModels().filter((model) => model.id === id);
    if (matches.length === 1) return matches[0]!;
    throw new RuntimeError(`Unknown or ambiguous model: ${id}`, 404, "model_not_found");
  }

  async *stream(
    request: CanonicalRequest,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    const model = this.resolveModel(request.model);
    const requestedReasoning = request.reasoningEffort ?? this.defaultReasoningEffort;
    const reasoning =
      model.reasoning && requestedReasoning !== "none"
        ? effectiveReasoningEffort(model, requestedReasoning)
        : undefined;
    const supportsSpeedMode = this.supportsSpeedMode(model.provider);
    if (request.speedMode === "fast" && !supportsSpeedMode) {
      throw new RuntimeError(
        "Fast speed is only available for OpenAI and ChatGPT / Codex models",
        400,
        "unsupported_speed_mode",
      );
    }
    const speedMode = supportsSpeedMode
      ? request.speedMode ?? this.defaultSpeedMode
      : "standard";
    const stream = this.models.streamSimple(model, toContext(request, model), {
      signal,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(model.reasoning && reasoning ? { reasoning } : {}),
      ...(supportsSpeedMode
        ? {
            onPayload: (payload: unknown) => {
              if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                throw new RuntimeError("Provider request payload is invalid");
              }
              return {
                ...payload,
                service_tier: speedMode === "fast" ? "priority" : "default",
              };
            },
          }
        : {}),
      maxRetries: 0,
    });
    for await (const event of stream) {
      if (event.type === "start") {
        yield { type: "start", model: `${model.provider}/${model.id}` };
      } else if (event.type === "text_delta") {
        yield { type: "text_delta", delta: event.delta };
      } else if (event.type === "toolcall_end") {
        yield {
          type: "tool_call",
          call: {
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          },
        };
      } else if (event.type === "done") {
        yield {
          type: "done",
          reason: event.reason === "toolUse" ? "tool_calls" : event.reason,
          usage: {
            input: event.message.usage.input,
            output: event.message.usage.output,
            total: event.message.usage.totalTokens,
          },
          ...(event.message.responseId ? { responseId: event.message.responseId } : {}),
        };
      } else if (event.type === "error") {
        throw mapProviderError(
          event.error.errorMessage ?? "Provider request failed",
          event.reason,
        );
      }
    }
  }
}
