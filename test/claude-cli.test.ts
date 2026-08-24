import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeCliRuntime,
  renderPrompt,
  scrubbedEnvironment,
} from "../src/main/claude-cli.ts";
import type { CanonicalEvent } from "../src/main/runtime.ts";
import type { ProviderConfig } from "../src/shared/contracts.ts";
import { tempPath } from "./helpers.ts";

const provider: ProviderConfig = {
  id: "claude-code",
  kind: "claude-code",
  name: "Claude Code",
  command: "/unused/claude",
  models: ["claude-opus-5", "claude-haiku-4-5-20251001"],
  createdAt: 1,
};

// The fake CLI is a Node script; spawn is injected so the tests do not depend
// on shebang execution, which Windows lacks.
async function fakeCli(script: string): Promise<{
  runtime: ClaudeCliRuntime;
  argsFile: string;
}> {
  const scriptPath = await tempPath("fake-claude.mjs");
  const argsFile = await tempPath("fake-claude-args.json");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, script, "utf8");
  const runtime = new ClaudeCliRuntime(provider, "high", ((command, args, options) =>
    spawn(
      process.execPath,
      [scriptPath, ...(args as string[])],
      {
        ...(options as object),
        env: {
          ...(options as { env: NodeJS.ProcessEnv }).env,
          LANE_TEST_ARGS_FILE: argsFile,
        },
      },
    )) as typeof spawn);
  return { runtime, argsFile };
}

const STREAMING_SCRIPT = `
import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  writeFileSync(process.env.LANE_TEST_ARGS_FILE, JSON.stringify({
    args: process.argv.slice(2),
    prompt,
    env: {
      anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    },
  }));
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  emit({ type: "system", subtype: "init", model: "claude-opus-5" });
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] } });
  emit({
    type: "result",
    is_error: false,
    usage: {
      input_tokens: 4,
      output_tokens: 2,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 3,
    },
  });
});
`;

async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const collected: CanonicalEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("claude cli runtime", () => {
  it("renders a single user message as the bare prompt", () => {
    expect(renderPrompt([{ role: "user", content: "hello" }])).toBe("hello");
  });

  it("flattens history into a role-labelled transcript", () => {
    expect(
      renderPrompt([
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ]),
    ).toBe("User: first\n\nAssistant: answer\n\nUser: second");
  });

  it("scrubs provider-routing environment variables", () => {
    const env = scrubbedEnvironment({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-x",
      ANTHROPIC_BASE_URL: "https://elsewhere",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      CLAUDE_CONFIG_DIR: "/tmp/other",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel",
      HOME: "/Users/someone",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/someone" });
  });

  it("streams deltas and reports subscription usage inclusive of cache", async () => {
    const { runtime, argsFile } = await fakeCli(STREAMING_SCRIPT);
    const events = await collect(
      runtime.stream(
        {
          model: "claude-code/claude-opus-5",
          systemPrompt: "Be terse.",
          messages: [{ role: "user", content: "hello" }],
          reasoningEffort: "max",
        },
        new AbortController().signal,
      ),
    );

    expect(events[0]).toEqual({ type: "start", model: "claude-code/claude-opus-5" });
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "stop",
      usage: { input: 17, cachedInput: 10, output: 2, total: 19 },
    });

    const { readFile } = await import("node:fs/promises");
    const capture = JSON.parse(await readFile(argsFile, "utf8"));
    expect(capture.prompt).toBe("hello");
    expect(capture.env).toEqual({ anthropicKey: null, configDir: null });
    for (const flag of [
      "--no-session-persistence",
      "--bare",
      "--strict-mcp-config",
      "--max-turns",
      "--effort",
    ]) {
      expect(capture.args).toContain(flag);
    }
    expect(capture.args).toContain("max");
    expect(capture.args.join(" ")).toContain("--tools ");
    expect(capture.args).toContain("claude-opus-5");
  });

  it("maps a CLI error result to a provider error", async () => {
    const { runtime } = await fakeCli(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }) + "\\n");
});
`);
    await expect(
      collect(
        runtime.stream(
          { model: "claude-code/claude-opus-5", messages: [{ role: "user", content: "hi" }] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("Not logged in");
  });

  it("rejects client tool calls up front", async () => {
    const { runtime } = await fakeCli(STREAMING_SCRIPT);
    await expect(
      collect(
        runtime.stream(
          {
            model: "claude-code/claude-opus-5",
            messages: [{ role: "user", content: "hi" }],
            tools: [{ name: "lookup", description: "lookup", parameters: {} }],
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/tool calls are not supported/i);
  });

  it("lists its catalog under the provider prefix", () => {
    const runtime = new ClaudeCliRuntime(provider);
    expect(runtime.listModels().map((model) => model.id)).toEqual([
      "claude-code/claude-opus-5",
      "claude-code/claude-haiku-4-5-20251001",
    ]);
    expect(runtime.ownsModel("claude-code/claude-opus-5")).toBe(true);
    expect(runtime.ownsModel("openai/gpt-5.6-luna")).toBe(false);
  });
});
