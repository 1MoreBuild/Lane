import { randomUUID } from "node:crypto";
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  CanonicalToolCall,
} from "./runtime.ts";
import { RuntimeError } from "./runtime.ts";

type JsonObject = Record<string, unknown>;

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
      messages.push({ role: "user", content: textContent(item.content) });
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
  return {
    ...parsed,
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.max_tokens === "number" ? { maxTokens: body.max_tokens } : {}),
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
  return {
    ...parsed,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.max_output_tokens === "number" ? { maxTokens: body.max_output_tokens } : {}),
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
