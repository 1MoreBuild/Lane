import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderConfig, PublicModel, ReasoningEffort } from "../shared/contracts.ts";
import type { CanonicalEvent, CanonicalRequest, ModelRuntime } from "./runtime.ts";
import { RuntimeError } from "./runtime.ts";

const execFileAsync = promisify(execFile);

// The catalog the subscription CLI serves. There is no discovery endpoint, so
// this mirrors the models Claude Code itself offers.
export const CLAUDE_CODE_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
];

const CLAUDE_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

function candidatePaths(): string[] {
  const home = homedir();
  return [
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    ...(process.platform === "win32"
      ? [join(home, ".local/bin/claude.exe"), join(home, "AppData/Local/Programs/claude/claude.exe")]
      : []),
  ];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findClaudeCli(override?: string): Promise<string | undefined> {
  if (override) return (await isExecutable(override)) ? override : undefined;
  for (const candidate of candidatePaths()) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export interface ClaudeCliDetection {
  command: string;
  version: string;
}

export async function detectClaudeCli(override?: string): Promise<ClaudeCliDetection> {
  const command = await findClaudeCli(override);
  if (!command) {
    throw new Error(
      "Claude Code CLI was not found. Install it and sign in, then try again.",
    );
  }
  const { stdout } = await execFileAsync(command, ["--version"], {
    timeout: 15_000,
  });
  const version = stdout.trim().split("\n")[0] ?? "";
  if (!version) throw new Error("Claude Code CLI did not report a version");
  return { command, version };
}

interface StreamJsonLine {
  type?: string;
  subtype?: string;
  model?: string;
  is_error?: boolean;
  error?: unknown;
  is_api_error_message?: boolean;
  result?: unknown;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  message?: {
    model?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentText(content: CanonicalRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      throw new RuntimeError(
        "Claude Code providers support text content only",
        400,
        "unsupported_content",
      );
    })
    .join("\n");
}

// The gateway is stateless, so history arrives with every request; the CLI is
// driven one turn at a time. Prior turns are flattened into a role-labelled
// transcript, the same reseeding shape Claude Code itself accepts.
export function renderPrompt(messages: CanonicalRequest["messages"]): string {
  if (messages.length === 1 && messages[0]?.role === "user") {
    return contentText(messages[0].content);
  }
  return messages
    .map((message) => {
      const label = message.role === "assistant" ? "Assistant" : "User";
      return `${label}: ${contentText(message.content)}`;
    })
    .join("\n\n");
}

// Claude Code honors provider-routing and auth environment variables before
// its own login, so inherited shell overrides must not steer a Lane request
// away from the user's subscription credentials.
const CLEARED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "OTEL_"];
const CLEARED_ENV_KEYS = ["CLAUDE_CONFIG_DIR"];

export function scrubbedEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (CLEARED_ENV_KEYS.includes(key)) continue;
    if (CLEARED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

export class ClaudeCliRuntime implements ModelRuntime {
  constructor(
    private readonly provider: ProviderConfig,
    private readonly defaultReasoningEffort: ReasoningEffort = "high",
    private readonly spawnImpl: typeof spawn = spawn,
  ) {}

  listModels(): PublicModel[] {
    return this.provider.models
      .map((id) => CLAUDE_CODE_MODELS.find((model) => model.id === id))
      .filter((model): model is (typeof CLAUDE_CODE_MODELS)[number] => Boolean(model))
      .map((model) => ({
        id: `${this.provider.id}/${model.id}`,
        provider: this.provider.id,
        name: model.name,
        reasoning: true,
        reasoningEfforts: [...CLAUDE_EFFORTS],
      }));
  }

  ownsModel(modelId: string | undefined): boolean {
    if (!modelId) return false;
    if (modelId.startsWith(`${this.provider.id}/`)) return true;
    return this.provider.models.includes(modelId);
  }

  private resolveModel(requested: string | undefined): string {
    if (!requested) throw new RuntimeError("No model selected", 400, "model_required");
    const bare = requested.startsWith(`${this.provider.id}/`)
      ? requested.slice(this.provider.id.length + 1)
      : requested;
    if (!this.provider.models.includes(bare)) {
      throw new RuntimeError(`Unknown or ambiguous model: ${requested}`, 404, "model_not_found");
    }
    return bare;
  }

  async *stream(
    request: CanonicalRequest,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    if (request.tools?.length) {
      throw new RuntimeError(
        "Client tool calls are not supported for Claude Code providers",
        400,
        "unsupported_feature",
      );
    }
    const model = this.resolveModel(request.model);
    const command = this.provider.command ?? (await findClaudeCli());
    if (!command) {
      throw new RuntimeError(
        "Claude Code CLI is not available",
        502,
        "provider_unavailable",
      );
    }
    const requested = request.reasoningEffort ?? this.defaultReasoningEffort;
    const effort: ReasoningEffort =
      requested === "none" || requested === "minimal" ? "low" : requested;
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      // One isolated completion: no sessions, no tools, no user customization.
      "--no-session-persistence",
      "--bare",
      "--setting-sources",
      "",
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--strict-mcp-config",
      "--max-turns",
      "1",
      "--permission-mode",
      "default",
      "--model",
      model,
      "--effort",
      effort,
      ...(request.systemPrompt ? ["--system-prompt", request.systemPrompt] : []),
    ];

    const child = this.spawnImpl(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: scrubbedEnvironment(),
    });
    const kill = () => child.kill();
    signal.addEventListener("abort", kill, { once: true });

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
    });

    child.stdin.write(renderPrompt(request.messages));
    child.stdin.end();

    const lines = createInterface({ input: child.stdout });
    let started = false;
    let sawDelta = false;
    let fallbackText = "";
    let doneEmitted = false;

    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let parsed: StreamJsonLine;
        try {
          parsed = JSON.parse(line) as StreamJsonLine;
        } catch {
          continue;
        }

        if (parsed.type === "system" && parsed.subtype === "init") {
          started = true;
          yield { type: "start", model: `${this.provider.id}/${parsed.model ?? model}` };
          continue;
        }

        if (parsed.type === "stream_event") {
          const event = parsed.event;
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            typeof event.delta.text === "string"
          ) {
            if (!started) {
              started = true;
              yield { type: "start", model: `${this.provider.id}/${model}` };
            }
            sawDelta = true;
            yield { type: "text_delta", delta: event.delta.text };
          }
          continue;
        }

        if (parsed.type === "assistant") {
          if (parsed.is_api_error_message || parsed.error) {
            const text = parsed.message?.content?.find((part) => part.type === "text")?.text;
            throw new RuntimeError(
              text || "Claude Code request failed",
              502,
              "provider_error",
            );
          }
          for (const part of parsed.message?.content ?? []) {
            if (part.type === "text" && typeof part.text === "string") {
              fallbackText += part.text;
            }
          }
          continue;
        }

        if (parsed.type === "result") {
          if (parsed.is_error) {
            throw new RuntimeError(
              typeof parsed.result === "string" ? parsed.result : "Claude Code request failed",
              502,
              "provider_error",
            );
          }
          if (!started) {
            started = true;
            yield { type: "start", model: `${this.provider.id}/${model}` };
          }
          if (!sawDelta && fallbackText) {
            yield { type: "text_delta", delta: fallbackText };
          }
          const usage = parsed.usage ?? {};
          const cacheRead = count(usage.cache_read_input_tokens);
          const cacheWrite = count(usage.cache_creation_input_tokens);
          const input = count(usage.input_tokens) + cacheRead + cacheWrite;
          const output = count(usage.output_tokens);
          doneEmitted = true;
          yield {
            type: "done",
            reason: "stop",
            usage: { input, cachedInput: cacheRead, output, total: input + output },
          };
        }
      }

      if (!doneEmitted) {
        if (signal.aborted) throw new RuntimeError("Request cancelled", 499, "request_cancelled");
        throw new RuntimeError(
          stderrTail.trim() || "Claude Code exited before completing the response",
          502,
          "provider_error",
        );
      }
    } finally {
      signal.removeEventListener("abort", kill);
      if (child.exitCode === null) child.kill();
    }
  }
}
