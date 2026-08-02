import { randomUUID } from "node:crypto";
import type {
  CanonicalEvent,
  CanonicalImageContent,
  CanonicalMessage,
  CanonicalReasoningEffort,
  CanonicalRequest,
  CanonicalSpeedMode,
  CanonicalTextContent,
  CanonicalUserContent,
  CanonicalTool,
  CanonicalToolCall,
} from "./runtime.ts";
import { RuntimeError } from "./runtime.ts";

type JsonObject = Record<string, unknown>;

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const REASONING_EFFORTS = new Set<CanonicalReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError(`${label} must be an object`, 400, "invalid_request");
  }
  return value as JsonObject;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as JsonObject;
      if (
        item.type === "text" ||
        item.type === "input_text" ||
        item.type === "output_text"
      ) {
        return typeof item.text === "string" ? item.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function imageUrl(part: JsonObject): string | undefined {
  const value = part.image_url;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const url = (value as JsonObject).url;
    if (typeof url === "string") return url;
  }
  return undefined;
}

function parseImageContent(part: JsonObject): CanonicalImageContent {
  const url = imageUrl(part);
  if (!url) {
    throw new RuntimeError("image_url is required", 400, "invalid_image");
  }
  const match = IMAGE_DATA_URL.exec(url);
  if (!match) {
    throw new RuntimeError(
      "Lane currently accepts input images as base64 data URLs",
      400,
      "unsupported_image_url",
    );
  }
  const data = match[2]!;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_INPUT_IMAGE_BYTES) {
    throw new RuntimeError(
      `Input images must be between 1 byte and ${MAX_INPUT_IMAGE_BYTES / 1024 / 1024} MiB`,
      400,
      "invalid_image",
    );
  }
  return { type: "image", mimeType: match[1]!.toLowerCase(), data };
}

function parseUserContent(value: unknown): CanonicalUserContent {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new RuntimeError("User content must be a string or array", 400, "invalid_request");
  }
  const content: Array<CanonicalTextContent | CanonicalImageContent> = [];
  for (const raw of value) {
    const part = asObject(raw, "content part");
    if (
      part.type === "text" ||
      part.type === "input_text" ||
      part.type === "output_text"
    ) {
      if (typeof part.text !== "string") {
        throw new RuntimeError("Text content requires text", 400, "invalid_request");
      }
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" || part.type === "input_image") {
      content.push(parseImageContent(part));
      continue;
    }
    throw new RuntimeError(
      `Unsupported user content type: ${String(part.type)}`,
      400,
      "invalid_request",
    );
  }
  return content;
}

function parseReasoningEffort(value: unknown): CanonicalReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !REASONING_EFFORTS.has(value as CanonicalReasoningEffort)) {
    throw new RuntimeError("Unsupported reasoning effort", 400, "invalid_request");
  }
  return value as CanonicalReasoningEffort;
}

function parseSpeedMode(value: unknown): CanonicalSpeedMode | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "default") return "standard";
  if (value === "fast" || value === "priority") return "fast";
  throw new RuntimeError(
    "service_tier must be auto, default, fast, or priority",
    400,
    "unsupported_service_tier",
  );
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new RuntimeError("Tool arguments must be valid JSON", 400, "invalid_request");
  }
}

function parseTools(value: unknown): CanonicalTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RuntimeError("tools must be an array", 400, "invalid_request");
  const tools: CanonicalTool[] = [];
  for (const item of value) {
    const tool = asObject(item, "tool");
    const definition =
      tool.type === "function" && tool.function && typeof tool.function === "object"
        ? (tool.function as JsonObject)
        : tool;
    if (typeof definition.name !== "string") {
      throw new RuntimeError("Tool name is required", 400, "invalid_request");
    }
    tools.push({
      name: definition.name,
      description:
        typeof definition.description === "string" ? definition.description : "",
      parameters:
        definition.parameters &&
        typeof definition.parameters === "object" &&
        !Array.isArray(definition.parameters)
          ? (definition.parameters as Record<string, unknown>)
          : { type: "object", properties: {} },
    });
  }
  return tools;
}

function parseChatMessages(value: unknown): {
  systemPrompt?: string;
  messages: CanonicalMessage[];
} {
  if (!Array.isArray(value)) {
    throw new RuntimeError("messages must be an array", 400, "invalid_request");
  }
  const system: string[] = [];
  const messages: CanonicalMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of value) {
    const item = asObject(raw, "message");
    const role = item.role;
    if (role === "system" || role === "developer") {
      const text = textContent(item.content);
      if (text) system.push(text);
      continue;
    }
    if (role === "user") {
      messages.push({ role: "user", content: parseUserContent(item.content) });
      continue;
    }
    if (role === "assistant") {
      const toolCalls: CanonicalToolCall[] = [];
      if (Array.isArray(item.tool_calls)) {
        for (const rawCall of item.tool_calls) {
          const call = asObject(rawCall, "tool call");
          const fn = asObject(call.function, "tool function");
          if (typeof fn.name !== "string") {
            throw new RuntimeError("Tool call name is required", 400, "invalid_request");
          }
          const id = typeof call.id === "string" ? call.id : randomUUID();
          toolNames.set(id, fn.name);
          toolCalls.push({
            id,
            name: fn.name,
            arguments: parseArguments(fn.arguments),
          });
        }
      }
      messages.push({
        role: "assistant",
        content: textContent(item.content),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
      continue;
    }
    if (role === "tool") {
      if (typeof item.tool_call_id !== "string") {
        throw new RuntimeError("tool_call_id is required", 400, "invalid_request");
      }
      messages.push({
        role: "tool",
        content: textContent(item.content),
        toolCallId: item.tool_call_id,
        toolName: toolNames.get(item.tool_call_id) ?? "tool",
      });
      continue;
    }
    throw new RuntimeError(`Unsupported message role: ${String(role)}`, 400, "invalid_request");
  }
  return {
    ...(system.length ? { systemPrompt: system.join("\n\n") } : {}),
    messages,
  };
}

export function parseChatRequest(value: unknown): CanonicalRequest {
  const body = asObject(value, "request");
  const parsed = parseChatMessages(body.messages);
  const tools = parseTools(body.tools);
  const reasoningEffort = parseReasoningEffort(body.reasoning_effort);
  const speedMode = parseSpeedMode(body.service_tier);
  return {
    ...parsed,
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.max_tokens === "number" ? { maxTokens: body.max_tokens } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(speedMode ? { speedMode } : {}),
    ...(tools ? { tools } : {}),
  };
}

function parseResponsesInput(value: unknown): ReturnType<typeof parseChatMessages> {
  if (typeof value === "string") return { messages: [{ role: "user", content: value }] };
  if (!Array.isArray(value)) {
    throw new RuntimeError("input must be a string or array", 400, "invalid_request");
  }
  const chatLike: JsonObject[] = [];
  for (const raw of value) {
    const item = asObject(raw, "input item");
    if (item.type === "function_call") {
      chatLike.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      chatLike.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
    } else {
      chatLike.push(item);
    }
  }
  return parseChatMessages(chatLike);
}

export function parseResponsesRequest(value: unknown): CanonicalRequest {
  const body = asObject(value, "request");
  const parsed = parseResponsesInput(body.input);
  const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
  const systemPrompt = [instructions, parsed.systemPrompt].filter(Boolean).join("\n\n");
  const tools = parseTools(body.tools);
  const reasoning =
    body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
      ? (body.reasoning as JsonObject).effort
      : undefined;
  const reasoningEffort = parseReasoningEffort(reasoning);
  const speedMode = parseSpeedMode(body.service_tier);
  return {
    ...parsed,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.max_output_tokens === "number" ? { maxTokens: body.max_output_tokens } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(speedMode ? { speedMode } : {}),
    ...(tools ? { tools } : {}),
  };
}

export interface CollectedResult {
  model: string;
  text: string;
  toolCalls: CanonicalToolCall[];
  reason: "stop" | "length" | "tool_calls";
  usage: { input: number; output: number; total: number };
  responseId?: string;
}

export async function collectEvents(events: AsyncIterable<CanonicalEvent>): Promise<CollectedResult> {
  let model = "";
  let text = "";
  const toolCalls: CanonicalToolCall[] = [];
  let done: Extract<CanonicalEvent, { type: "done" }> | undefined;
  for await (const event of events) {
    if (event.type === "start") model = event.model;
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "tool_call") toolCalls.push(event.call);
    if (event.type === "done") done = event;
  }
  if (!done) throw new RuntimeError("Provider stream ended without completion");
  return {
    model,
    text,
    toolCalls,
    reason: done.reason,
    usage: done.usage,
    ...(done.responseId ? { responseId: done.responseId } : {}),
  };
}

export function chatCompletion(result: CollectedResult, id = `chatcmpl_${randomUUID()}`): JsonObject {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.text || null,
          ...(result.toolCalls.length
            ? {
                tool_calls: result.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        },
        finish_reason:
          result.reason === "tool_calls"
            ? "tool_calls"
            : result.reason === "length"
              ? "length"
              : "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage.input,
      completion_tokens: result.usage.output,
      total_tokens: result.usage.total,
    },
  };
}

export function responsesCompletion(
  result: CollectedResult,
  id = result.responseId ?? `resp_${randomUUID()}`,
): JsonObject {
  const messageId = `msg_${randomUUID()}`;
  const output: JsonObject[] = [];
  if (result.text) {
    output.push({
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    });
  }
  for (const call of result.toolCalls) {
    output.push({
      type: "function_call",
      id: `fc_${randomUUID()}`,
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
      status: "completed",
    });
  }
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: result.model,
    output,
    output_text: result.text,
    usage: {
      input_tokens: result.usage.input,
      output_tokens: result.usage.output,
      total_tokens: result.usage.total,
    },
  };
}
