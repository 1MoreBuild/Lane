import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  GatewayCapture,
  GatewayCapturedBody,
  GatewayConfig,
} from "../shared/contracts.ts";
import { LaneLogger, redact } from "./logger.ts";
import {
  chatCompletion,
  collectEvents,
  parseChatRequest,
  parseResponsesRequest,
  responsesCompletion,
} from "./protocol.ts";
import type {
  CanonicalImageRequest,
  CanonicalRequest,
  ModelRuntime,
} from "./runtime.ts";
import { RuntimeError } from "./runtime.ts";
import {
  constantTimeKeyEqual,
  extractClientKey,
  LOOPBACK_HOST,
} from "./security.ts";

// A 20 MiB input image expands by roughly one third when encoded as a data URL.
const MAX_BODY_BYTES = 30 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 1024 * 1024;

class BodyRecorder {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private totalBytes = 0;

  append(value: Buffer | string): void {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.totalBytes += buffer.length;
    const remaining = MAX_CAPTURE_BYTES - this.capturedBytes;
    if (remaining <= 0) return;
    const captured = buffer.subarray(0, remaining);
    this.chunks.push(captured);
    this.capturedBytes += captured.length;
  }

  snapshot(contentType: string | undefined): GatewayCapturedBody | undefined {
    if (this.totalBytes === 0) return undefined;
    const captured = Buffer.concat(this.chunks);
    let body = captured.toString("utf8");
    let representedBytes = captured.length;
    for (let trim = 0; trim <= Math.min(3, captured.length); trim += 1) {
      const candidate = captured.subarray(0, captured.length - trim);
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(candidate);
        representedBytes = candidate.length;
        break;
      } catch {
        // A capacity boundary may split one UTF-8 code point; omit that partial tail.
      }
    }
    return {
      body,
      ...(contentType ? { contentType } : {}),
      capturedBytes: representedBytes,
      totalBytes: this.totalBytes,
      truncated: representedBytes < this.totalBytes,
    };
  }
}

const responseRecorders = new WeakMap<ServerResponse, BodyRecorder>();

function headerText(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return value;
}

export class GatewayStartError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class RuntimeHolder implements ModelRuntime {
  constructor(private current: ModelRuntime) {}

  set(runtime: ModelRuntime): void {
    this.current = runtime;
  }

  listModels() {
    return this.current.listModels();
  }

  listImageModels() {
    return this.current.listImageModels?.() ?? [];
  }

  stream(request: CanonicalRequest, signal: AbortSignal) {
    return this.current.stream(request, signal);
  }

  generateImages(request: CanonicalImageRequest, signal: AbortSignal) {
    if (!this.current.generateImages) {
      throw new RuntimeError(
        "No image providers are configured",
        400,
        "image_model_required",
      );
    }
    return this.current.generateImages(request, signal);
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  responseRecorders.get(response)?.append(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function openAiError(error: unknown): { status: number; body: unknown } {
  const runtime =
    error instanceof RuntimeError
      ? error
      : new RuntimeError(redact(error instanceof Error ? error.message : error));
  return {
    status: runtime.status,
    body: {
      error: {
        message: redact(runtime.message),
        type: runtime.code,
        code: runtime.code,
      },
    },
  };
}

async function readJson(
  request: IncomingMessage,
  recorder?: BodyRecorder,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    recorder?.append(buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RuntimeError("Request body exceeds 30 MiB", 413, "request_too_large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuntimeError("Request body must be valid JSON", 400, "invalid_json");
  }
}

function parseImageRequest(value: unknown): CanonicalImageRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError("Request body must be an object", 400, "invalid_request_error");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new RuntimeError("prompt is required", 400, "invalid_request_error");
  }
  if (input.prompt.length > 32_000) {
    throw new RuntimeError("prompt exceeds 32000 characters", 400, "invalid_request_error");
  }
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" || !input.model.trim())
  ) {
    throw new RuntimeError("model must be a non-empty string", 400, "invalid_request_error");
  }
  if (
    input.n !== undefined &&
    (!Number.isInteger(input.n) || (input.n as number) < 1 || (input.n as number) > 10)
  ) {
    throw new RuntimeError("n must be an integer from 1 to 10", 400, "invalid_request_error");
  }
  if (
    input.quality !== undefined &&
    !["auto", "low", "medium", "high"].includes(String(input.quality))
  ) {
    throw new RuntimeError("quality is not supported", 400, "invalid_request_error");
  }
  if (
    input.size !== undefined &&
    (typeof input.size !== "string" ||
      (input.size !== "auto" && !/^\d{2,4}x\d{2,4}$/.test(input.size)))
  ) {
    throw new RuntimeError("size must be auto or WIDTHxHEIGHT", 400, "invalid_request_error");
  }
  if (
    input.background !== undefined &&
    !["auto", "opaque", "transparent"].includes(String(input.background))
  ) {
    throw new RuntimeError("background is not supported", 400, "invalid_request_error");
  }
  if (
    input.output_format !== undefined &&
    !["png", "jpeg", "webp"].includes(String(input.output_format))
  ) {
    throw new RuntimeError("output_format is not supported", 400, "invalid_request_error");
  }
  if (
    input.output_compression !== undefined &&
    (!Number.isInteger(input.output_compression) ||
      (input.output_compression as number) < 0 ||
      (input.output_compression as number) > 100)
  ) {
    throw new RuntimeError(
      "output_compression must be an integer from 0 to 100",
      400,
      "invalid_request_error",
    );
  }
  if (
    input.moderation !== undefined &&
    !["auto", "low"].includes(String(input.moderation))
  ) {
    throw new RuntimeError("moderation is not supported", 400, "invalid_request_error");
  }
  if (
    input.response_format !== undefined &&
    input.response_format !== "b64_json"
  ) {
    throw new RuntimeError(
      "GPT Image models return b64_json",
      400,
      "unsupported_parameter",
    );
  }
  if (input.stream === true) {
    throw new RuntimeError(
      "Image streaming is not supported by this Lane version",
      400,
      "unsupported_parameter",
    );
  }
  if (
    input.user !== undefined &&
    (typeof input.user !== "string" || input.user.length > 256)
  ) {
    throw new RuntimeError("user must be a string up to 256 characters", 400, "invalid_request_error");
  }
  const result: CanonicalImageRequest = { prompt: input.prompt.trim() };
  if (typeof input.model === "string") result.model = input.model;
  if (typeof input.n === "number") result.n = input.n;
  if (typeof input.quality === "string") {
    result.quality = input.quality as NonNullable<CanonicalImageRequest["quality"]>;
  }
  if (typeof input.size === "string") result.size = input.size;
  if (typeof input.background === "string") {
    result.background =
      input.background as NonNullable<CanonicalImageRequest["background"]>;
  }
  if (typeof input.output_format === "string") {
    result.outputFormat =
      input.output_format as NonNullable<CanonicalImageRequest["outputFormat"]>;
  }
  if (typeof input.output_compression === "number") {
    result.outputCompression = input.output_compression;
  }
  if (typeof input.moderation === "string") {
    result.moderation =
      input.moderation as NonNullable<CanonicalImageRequest["moderation"]>;
  }
  if (typeof input.user === "string") result.user = input.user;
  return result;
}

function canWrite(response: ServerResponse): boolean {
  return response.writable && !response.destroyed && !response.writableEnded;
}

function sse(response: ServerResponse, event: string | undefined, data: unknown): boolean {
  if (!canWrite(response)) return false;
  const payload = `${event ? `event: ${event}\n` : ""}data: ${
    typeof data === "string" ? data : JSON.stringify(data)
  }\n\n`;
  response.write(payload);
  responseRecorders.get(response)?.append(payload);
  return true;
}

function allowOrigin(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.includes(origin)) {
    json(response, 403, {
      error: {
        message: "Origin is not allowed",
        type: "cors_origin_denied",
        code: "cors_origin_denied",
      },
    });
    return false;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  return true;
}

function authorize(request: IncomingMessage, expected: string): boolean {
  return constantTimeKeyEqual(extractClientKey(request.headers), expected);
}

function streamHeaders(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
}

interface GatewayExecutionSummary {
  model?: string;
  usage?: { input: number; output: number; total: number };
  imageCount?: number;
}

function providerFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : undefined;
}

async function streamChat(
  runtime: ModelRuntime,
  request: CanonicalRequest,
  signal: AbortSignal,
  response: ServerResponse,
): Promise<GatewayExecutionSummary> {
  const id = `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  streamHeaders(response);
  let model = request.model ?? "";
  let sentRole = false;
  let usage: GatewayExecutionSummary["usage"];
  for await (const event of runtime.stream(request, signal)) {
    if (event.type === "start") {
      model = event.model;
      sse(response, undefined, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
      sentRole = true;
    } else if (event.type === "text_delta") {
      sse(response, undefined, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
      });
    } else if (event.type === "tool_call") {
      sse(response, undefined, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: event.call.id,
                  type: "function",
                  function: {
                    name: event.call.name,
                    arguments: JSON.stringify(event.call.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    } else if (event.type === "done") {
      usage = event.usage;
      if (!sentRole) model = request.model ?? "";
      sse(response, undefined, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason:
              event.reason === "tool_calls"
                ? "tool_calls"
                : event.reason === "length"
                  ? "length"
                  : "stop",
          },
        ],
        usage: {
          prompt_tokens: event.usage.input,
          completion_tokens: event.usage.output,
          total_tokens: event.usage.total,
        },
      });
    }
  }
  sse(response, undefined, "[DONE]");
  return { ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
}

async function streamResponses(
  runtime: ModelRuntime,
  request: CanonicalRequest,
  signal: AbortSignal,
  response: ServerResponse,
): Promise<GatewayExecutionSummary> {
  const id = `resp_${randomUUID()}`;
  const itemId = `msg_${randomUUID()}`;
  let sequence = 0;
  let model = request.model ?? "";
  let text = "";
  const toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }> = [];
  let usage: GatewayExecutionSummary["usage"];
  streamHeaders(response);
  for await (const event of runtime.stream(request, signal)) {
    if (event.type === "start") {
      model = event.model;
      sse(response, "response.created", {
        type: "response.created",
        sequence_number: sequence++,
        response: {
          id,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "in_progress",
          model,
          output: [],
        },
      });
      sse(response, "response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: sequence++,
        output_index: 0,
        item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
    } else if (event.type === "text_delta") {
      text += event.delta;
      sse(response, "response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: sequence++,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: event.delta,
      });
    } else if (event.type === "tool_call") {
      toolCalls.push(event.call);
      sse(response, "response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: sequence++,
        output_index: 1,
        item: {
          type: "function_call",
          id: `fc_${randomUUID()}`,
          call_id: event.call.id,
          name: event.call.name,
          arguments: JSON.stringify(event.call.arguments),
          status: "completed",
        },
      });
    } else if (event.type === "done") {
      usage = event.usage;
      sse(response, "response.output_text.done", {
        type: "response.output_text.done",
        sequence_number: sequence++,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text,
      });
      const completed = responsesCompletion({
        model,
        text,
        toolCalls,
        reason: event.reason,
        usage: event.usage,
        responseId: id,
      });
      sse(response, "response.completed", {
        type: "response.completed",
        sequence_number: sequence++,
        response: completed,
      });
    }
  }
  return { ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
}

export class GatewayServer {
  private server: Server | undefined;
  private endpoint: string | undefined;
  private allowedOrigins: readonly string[] = [];
  private captureEnabled = false;
  lastError: string | undefined;

  constructor(
    private readonly runtime: ModelRuntime,
    private readonly logger = new LaneLogger(),
  ) {}

  isRunning(): boolean {
    return this.server?.listening === true;
  }

  isCaptureEnabled(): boolean {
    return this.captureEnabled;
  }

  setCaptureEnabled(enabled: boolean): void {
    this.captureEnabled = enabled;
  }

  getEndpoint(port = 3210): string {
    return this.endpoint ?? `http://${LOOPBACK_HOST}:${port}`;
  }

  async start(config: GatewayConfig, clientKey: string): Promise<void> {
    if (this.server) return;
    this.lastError = undefined;
    this.allowedOrigins = [...config.allowedOrigins];
    const server = createServer(async (request, response) => {
      let finished = false;
      const startedAt = Date.now();
      const requestId = randomUUID();
      const method = (request.method ?? "UNKNOWN").toUpperCase().slice(0, 12);
      const path = (() => {
        try {
          return new URL(request.url ?? "/", this.getEndpoint(config.port)).pathname.slice(0, 160);
        } catch {
          return "/";
        }
      })();
      const shouldTrace = method !== "OPTIONS";
      const captureThisRequest = shouldTrace && this.captureEnabled;
      const requestRecorder = captureThisRequest ? new BodyRecorder() : undefined;
      const responseRecorder = captureThisRequest ? new BodyRecorder() : undefined;
      if (responseRecorder) responseRecorders.set(response, responseRecorder);
      let execution: GatewayExecutionSummary = {};
      let stream: boolean | undefined;
      let errorCode: string | undefined;
      let traceStatus: number | undefined;
      const controller = new AbortController();
      response.once("close", () => {
        if (!finished) controller.abort();
      });
      request.once("aborted", () => controller.abort());
      if (shouldTrace) {
        this.logger.trace("info", `${method} ${path}`, {
          kind: "gateway",
          requestId,
          phase: "started",
          method,
          path,
        });
      }
      try {
        if (!allowOrigin(request, response, this.allowedOrigins)) {
          errorCode = "cors_origin_denied";
          return;
        }
        if (request.method === "OPTIONS") {
          response.statusCode = 204;
          response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Lane-Key");
          response.setHeader("Access-Control-Max-Age", "600");
          response.end();
          return;
        }
        if (!authorize(request, clientKey)) {
          errorCode = "invalid_lane_key";
          json(response, 401, {
            error: {
              message: "Missing or invalid Lane client key",
              type: "authentication_error",
              code: "invalid_lane_key",
            },
          });
          return;
        }
        const url = new URL(request.url ?? "/", this.getEndpoint(config.port));
        if (request.method === "GET" && url.pathname === "/health") {
          json(response, 200, { status: "ok", service: "lane", bind: LOOPBACK_HOST });
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/models") {
          const models = await this.runtime.listModels();
          const imageModels = (await this.runtime.listImageModels?.()) ?? [];
          const combined = new Map<
            string,
            { id: string; provider: string; capabilities: Set<string> }
          >();
          for (const model of models) {
            combined.set(model.id, {
              id: model.id,
              provider: model.provider,
              capabilities: new Set(["chat"]),
            });
          }
          for (const model of imageModels) {
            const existing = combined.get(model.id);
            if (existing) existing.capabilities.add("image_generation");
            else {
              combined.set(model.id, {
                id: model.id,
                provider: model.provider,
                capabilities: new Set(["image_generation"]),
              });
            }
          }
          json(response, 200, {
            object: "list",
            data: [...combined.values()].map((model) => ({
              id: model.id,
              object: "model",
              created: 0,
              owned_by: model.provider,
              lane_capabilities: [...model.capabilities],
            })),
          });
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/v1/images/generations"
        ) {
          const generateImages = this.runtime.generateImages;
          if (!generateImages) {
            throw new RuntimeError(
              "No image providers are configured",
              400,
              "image_model_required",
            );
          }
          const result = await generateImages.call(
            this.runtime,
            parseImageRequest(await readJson(request, requestRecorder)),
            controller.signal,
          );
          execution = { model: result.model, imageCount: result.images.length };
          json(response, 200, {
            created: result.created,
            data: result.images.map((image) => ({
              b64_json: image.b64Json,
              ...(image.revisedPrompt
                ? { revised_prompt: image.revisedPrompt }
                : {}),
            })),
          });
          return;
        }
        if (
          request.method === "POST" &&
          (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")
        ) {
          const body = await readJson(request, requestRecorder);
          const wantsStream =
            Boolean(body) &&
            typeof body === "object" &&
            (body as { stream?: unknown }).stream === true;
          stream = wantsStream;
          const canonical =
            url.pathname === "/v1/chat/completions"
              ? parseChatRequest(body)
              : parseResponsesRequest(body);
          if (wantsStream) {
            if (url.pathname === "/v1/chat/completions") {
              execution = await streamChat(
                this.runtime,
                canonical,
                controller.signal,
                response,
              );
            } else {
              execution = await streamResponses(
                this.runtime,
                canonical,
                controller.signal,
                response,
              );
            }
            finished = true;
            response.end();
            return;
          }
          const result = await collectEvents(this.runtime.stream(canonical, controller.signal));
          execution = { model: result.model, usage: result.usage };
          json(
            response,
            200,
            url.pathname === "/v1/chat/completions"
              ? chatCompletion(result)
              : responsesCompletion(result),
          );
          return;
        }
        errorCode = "not_found";
        json(response, 404, {
          error: { message: "Route not found", type: "not_found", code: "not_found" },
        });
      } catch (error) {
        const mapped = openAiError(error);
        errorCode = controller.signal.aborted
          ? "request_cancelled"
          : error instanceof RuntimeError
            ? error.code
            : "internal_error";
        traceStatus = mapped.status;
        if (response.headersSent) {
          if (sse(response, "error", mapped.body)) response.end();
        } else if (!response.destroyed) {
          json(response, mapped.status, mapped.body);
        }
      } finally {
        finished = true;
        if (shouldTrace) {
          const durationMs = Math.max(0, Date.now() - startedAt);
          const cancelled = controller.signal.aborted;
          const status = traceStatus ?? response.statusCode;
          const level = cancelled || status >= 400 ? (status >= 500 ? "error" : "warn") : "info";
          const provider = providerFromModel(execution.model);
          const capturedRequest = requestRecorder?.snapshot(
            headerText(request.headers["content-type"]),
          );
          const capturedResponse = responseRecorder?.snapshot(
            headerText(response.getHeader("content-type")),
          );
          const capture: GatewayCapture | undefined = captureThisRequest
            ? {
                ...(capturedRequest ? { request: capturedRequest } : {}),
                ...(capturedResponse ? { response: capturedResponse } : {}),
              }
            : undefined;
          this.logger.trace(
            level,
            `${method} ${path} · ${cancelled ? "cancelled" : status} · ${durationMs} ms`,
            {
              kind: "gateway",
              requestId,
              phase: "completed",
              method,
              path,
              ...(stream !== undefined ? { stream } : {}),
              ...(execution.model ? { model: execution.model } : {}),
              ...(provider ? { provider } : {}),
              status,
              durationMs,
              ...(execution.usage
                ? {
                    inputTokens: execution.usage.input,
                    outputTokens: execution.usage.output,
                    totalTokens: execution.usage.total,
                  }
                : {}),
              ...(execution.imageCount !== undefined
                ? { imageCount: execution.imageCount }
                : {}),
              ...(errorCode ? { errorCode } : {}),
              ...(cancelled ? { cancelled: true } : {}),
            },
            capture && (capture.request || capture.response) ? capture : undefined,
          );
        }
        responseRecorders.delete(response);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        const message =
          error.code === "EADDRINUSE"
            ? `Port ${config.port} is already in use`
            : `Gateway failed to start: ${redact(error.message)}`;
        this.lastError = message;
        reject(new GatewayStartError(message, error.code ?? "GATEWAY_START_FAILED"));
      });
      server.listen(config.port, LOOPBACK_HOST, () => resolve());
    });
    this.server = server;
    this.endpoint = `http://${LOOPBACK_HOST}:${config.port}`;
  }

  setAllowedOrigins(origins: readonly string[]): void {
    this.allowedOrigins = [...origins];
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    this.allowedOrigins = [];
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}
