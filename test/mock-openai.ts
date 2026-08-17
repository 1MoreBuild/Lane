import { createServer } from "node:http";
import { freePort } from "./helpers.ts";

export interface MockOpenAI {
  baseUrl: string;
  requests: Array<{ path: string; authorization?: string; body?: unknown }>;
  abortedRequests: number;
  close(): Promise<void>;
}

export async function startMockOpenAI(): Promise<MockOpenAI> {
  const port = await freePort();
  const requests: MockOpenAI["requests"] = [];
  const state = { abortedRequests: 0 };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body: any;
    if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      path: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    if (request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            { id: "mock-model", name: "Mock Model" },
            { id: "mock-image", name: "Mock Image" },
          ],
        }),
      );
      return;
    }
    if (request.url === "/v1/images/generations") {
      if (body?.prompt === "upstream-error") {
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ error: { message: "mock image failure" } }));
        return;
      }
      if (body?.prompt === "slow-image") {
        const interval = setInterval(() => {}, 50);
        response.on("close", () => {
          clearInterval(interval);
          state.abortedRequests += 1;
        });
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.setHeader("x-request-id", "mock-image-request");
      response.end(
        JSON.stringify({
          created: 1,
          output_format: body?.output_format ?? "png",
          data: Array.from({ length: body?.n ?? 1 }, (_value, index) => ({
            b64_json: Buffer.from(`mock-image-data-${index}`).toString("base64"),
            revised_prompt: `revised ${index}: ${body?.prompt ?? ""}`,
          })),
        }),
      );
      return;
    }
    if (request.url !== "/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const serialized = JSON.stringify(body);
    if (serialized.includes("upstream-error")) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          error: { message: "mock upstream exploded", type: "server_error", code: "mock_error" },
        }),
      );
      return;
    }
    if (body?.stream === true) {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      send({
        id: "mock-chat",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      if (serialized.includes("parallel-tool-calls")) {
        send({
          id: "mock-chat",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta: { content: "working" }, finish_reason: null }],
        });
        for (const [index, name] of ["alpha", "beta"].entries()) {
          send({
            id: "mock-chat",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-model",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: `call_${name}`,
                      type: "function",
                      function: { name, arguments: '{"value":1}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
        send({
          id: "mock-chat",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
        });
        response.end("data: [DONE]\n\n");
        return;
      }
      if (serialized.includes("slow-stream")) {
        const interval = setInterval(() => response.write(": waiting\n\n"), 50);
        response.on("close", () => {
          clearInterval(interval);
          state.abortedRequests += 1;
        });
        return;
      }
      send({
        id: "mock-chat",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      });
      send({
        id: "mock-chat",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model",
        choices: [{ index: 0, delta: { content: " from mock" }, finish_reason: null }],
      });
      send({
        id: "mock-chat",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 3,
          total_tokens: 6,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      });
      response.end("data: [DONE]\n\n");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: "mock-chat",
        object: "chat.completion",
        created: 1,
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello from mock" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 3,
          total_tokens: 6,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    get abortedRequests() {
      return state.abortedRequests;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
