import { describe, expect, it } from "vitest";
import {
  chatCompletion,
  collectEvents,
  parseChatRequest,
  parseResponsesRequest,
  responsesCompletion,
} from "../src/main/protocol.ts";
import type { CanonicalEvent } from "../src/main/runtime.ts";

async function* events(): AsyncIterable<CanonicalEvent> {
  yield { type: "start", model: "mock/model" };
  yield { type: "text_delta", delta: "hello " };
  yield { type: "text_delta", delta: "world" };
  yield {
    type: "tool_call",
    call: { id: "call_1", name: "lookup", arguments: { q: "lane" } },
  };
  yield {
    type: "done",
    reason: "tool_calls",
    usage: { input: 4, output: 3, total: 7 },
  };
}

describe("OpenAI protocol adapters", () => {
  it("maps chat messages and tools into the canonical request", () => {
    const request = parseChatRequest({
      model: "mock/model",
      messages: [
        { role: "system", content: "Be direct." },
        { role: "user", content: "Find it." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"lane"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "found" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Lookup",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
    });
    expect(request.systemPrompt).toBe("Be direct.");
    expect(request.messages).toHaveLength(3);
    expect(request.tools?.[0]?.name).toBe("lookup");
  });

  it("maps Responses input and instructions", () => {
    const request = parseResponsesRequest({
      model: "mock/model",
      instructions: "Be concise.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    });
    expect(request.systemPrompt).toBe("Be concise.");
    expect(request.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("maps Responses function calls and outputs without executing them", () => {
    const request = parseResponsesRequest({
      model: "mock/model",
      input: [
        {
          type: "function_call",
          call_id: "call_9",
          name: "lookup",
          arguments: '{"q":"lane"}',
        },
        {
          type: "function_call_output",
          call_id: "call_9",
          output: "found",
        },
      ],
    });
    expect(request.messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "call_9", name: "lookup" }],
    });
    expect(request.messages[1]).toEqual({
      role: "tool",
      toolCallId: "call_9",
      toolName: "lookup",
      content: "found",
    });
  });

  it("converts streamed events to both non-streaming response formats", async () => {
    const collected = await collectEvents(events());
    const chat = chatCompletion(collected) as any;
    expect(chat.choices[0].message.content).toBe("hello world");
    expect(chat.choices[0].finish_reason).toBe("tool_calls");
    expect(chat.usage.total_tokens).toBe(7);
    const response = responsesCompletion(collected) as any;
    expect(response.output_text).toBe("hello world");
    expect(response.output.some((item: any) => item.type === "function_call")).toBe(true);
    expect(response.usage.total_tokens).toBe(7);
  });
});
