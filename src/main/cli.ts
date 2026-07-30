import type {
  CliControlRequest,
  CliControlResponse,
} from "./cli-control.ts";
import { requestCliControl } from "./cli-control.ts";

const TOP_LEVEL_COMMANDS = [
  "status",
  "start",
  "stop",
  "open",
  "connection",
  "activity",
  "providers",
  "models",
  "schema",
] as const;
type LaneCliCommand =
  | "status"
  | "start"
  | "stop"
  | "open"
  | "connection"
  | "activity"
  | "providers-list"
  | "providers-add"
  | "providers-remove"
  | "providers-oauth"
  | "models"
  | "models-set-default"
  | "models-set-default-image"
  | "schema";
type OutputMode = "human" | "json" | "plain";

export interface LaneCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
  isTTY: boolean;
}

export interface LaneCliOptions {
  socketPath: string;
  version: string;
  wakeApp?: () => Promise<void>;
  request?: typeof requestCliControl;
  readStdin?: () => Promise<string>;
  io?: LaneCliIo;
}

interface ParsedCli {
  command?: LaneCliCommand;
  mode: OutputMode;
  help: boolean;
  version: boolean;
  force: boolean;
  apiKeyStdin: boolean;
  kind?: string;
  name?: string;
  baseUrl?: string;
  id?: string;
}

interface CliErrorPayload {
  error: string;
  message: string;
  fix: string;
  retryable: boolean;
}

const HELP = `Lane CLI

Usage:
  lane <command> [--json | --plain] [--no-input]

Gateway:
  status                         Show gateway and provider status
  start                          Start the local gateway
  stop                           Stop the local gateway
  connection                     Print API URL, endpoints, and Lane client key
  open                           Open the Lane app

Providers:
  providers [list]               List configured providers
  providers add --kind <kind> --api-key-stdin [--name <name>] [--base-url <url>]
  providers remove --id <id> --force
  providers login                Start ChatGPT / Codex browser OAuth

Models and diagnostics:
  models [list]                  List available models
  models set-default --id <id>   Set the fallback model
  models set-default-image --id <id>
                                 Set the image generation model
  activity                       Print redacted recent activity
  schema                         Print the machine-readable command schema

Flags:
  --json                         Print stable JSON
  --plain                        Print stable line-oriented output
  --no-input                     Never prompt
  --api-key-stdin                Read an API key from stdin
  --force, --yes                 Confirm a destructive operation
  --no-color                     Disable color
  -h, --help                     Show help
  -V, --version                  Show version
`;

export const LANE_CLI_SCHEMA = {
  name: "lane",
  version: 1,
  description: "Configure and control the local Lane AI gateway.",
  commands: {
    status: { mutation: false, output: "object" },
    start: { mutation: true, idempotent: true, output: "object" },
    stop: { mutation: true, idempotent: true, output: "object" },
    connection: { mutation: false, output: "object", contains_secret: true },
    open: { mutation: true, idempotent: true, output: "object" },
    "providers list": { mutation: false, output: "array" },
    "providers add": {
      mutation: true,
      output: "object",
      secret_input: "stdin",
    },
    "providers remove": {
      mutation: true,
      output: "object",
      requires_force: true,
    },
    "providers login": { mutation: true, interactive: true, output: "object" },
    models: { mutation: false, output: "array" },
    "models set-default": { mutation: true, idempotent: true, output: "object" },
    "models set-default-image": {
      mutation: true,
      idempotent: true,
      output: "object",
    },
    activity: { mutation: false, output: "array", redacted: true },
    schema: { mutation: false, output: "object", local: true },
  },
  flags: {
    "--json": "Stable JSON output",
    "--plain": "Stable line-oriented output",
    "--no-input": "Disable prompts",
    "--api-key-stdin": "Read a provider API key from stdin",
    "--force": "Confirm a destructive operation",
  },
  exit_codes: {
    0: "success",
    1: "failure",
    2: "invalid usage",
    4: "CLI integration unavailable",
    8: "retryable Lane service error",
    130: "cancelled",
  },
} as const;

function parseArguments(args: string[]): ParsedCli {
  let mode: OutputMode = "human";
  let help = false;
  let version = false;
  let force = false;
  let apiKeyStdin = false;
  const values: Partial<Record<"kind" | "name" | "baseUrl" | "id", string>> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      if (mode === "plain") throw new Error("--json and --plain cannot be combined");
      mode = "json";
    } else if (arg === "--plain") {
      if (mode === "json") throw new Error("--json and --plain cannot be combined");
      mode = "plain";
    } else if (arg === "--no-input" || arg === "--no-color") {
      continue;
    } else if (arg === "--force" || arg === "--yes") {
      force = true;
    } else if (arg === "--api-key-stdin") {
      apiKeyStdin = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-V" || arg === "--version") {
      version = true;
    } else if (["--kind", "--name", "--base-url", "--id"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      const key =
        arg === "--base-url" ? "baseUrl" : (arg.slice(2) as "kind" | "name" | "id");
      values[key] = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (help || version) {
    return {
      mode,
      help,
      version,
      force,
      apiKeyStdin,
      ...values,
    };
  }

  let command: LaneCliCommand | undefined;
  const [group, action, extra] = positional;
  if (extra) throw new Error(`Unexpected argument: ${extra}`);
  if (!group) {
    command = undefined;
  } else if (["status", "start", "stop", "open", "connection", "activity", "schema"].includes(group)) {
    if (action) throw new Error(`Unexpected argument for ${group}: ${action}`);
    command = group as LaneCliCommand;
  } else if (group === "providers") {
    if (!action || action === "list") command = "providers-list";
    else if (action === "add") command = "providers-add";
    else if (action === "remove") command = "providers-remove";
    else if (action === "login") command = "providers-oauth";
    else throw new Error(`Unknown providers command: ${action}`);
  } else if (group === "models") {
    if (!action || action === "list") command = "models";
    else if (action === "set-default") command = "models-set-default";
    else if (action === "set-default-image") command = "models-set-default-image";
    else throw new Error(`Unknown models command: ${action}`);
  } else {
    throw new Error(`Unknown command: ${group}`);
  }

  return {
    ...(command ? { command } : {}),
    mode,
    help,
    version,
    force,
    apiKeyStdin,
    ...values,
  };
}

function errorPayload(
  code: string,
  message: string,
  retryable: boolean,
  fix = "Open Lane → Settings → Command line → Install…, then retry.",
): CliErrorPayload {
  return { error: code, message, fix, retryable };
}

function writeError(io: LaneCliIo, mode: OutputMode, payload: CliErrorPayload): void {
  if (mode === "json") {
    io.stderr(`${JSON.stringify(payload)}\n`);
    return;
  }
  io.stderr(`lane: ${payload.message}\nFix: ${payload.fix}\n`);
}

function humanStatus(value: unknown): string {
  const status = value as {
    gateway?: { running?: boolean; api_base_url?: string };
    default_model?: string | null;
    default_image_model?: string | null;
    providers?: { connected?: number; total?: number };
  };
  return `${[
    `Gateway: ${status.gateway?.running ? "running" : "stopped"}`,
    ...(status.gateway?.api_base_url ? [`API: ${status.gateway.api_base_url}`] : []),
    `Default model: ${status.default_model ?? "not set"}`,
    `Image model: ${status.default_image_model ?? "not set"}`,
    `Providers: ${status.providers?.connected ?? 0}/${status.providers?.total ?? 0} connected`,
  ].join("\n")}\n`;
}

function tabular(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return `${value
    .map((item) => {
      const row = item as Record<string, unknown>;
      return Object.values(row)
        .filter((field) => typeof field !== "object")
        .map((field) => String(field ?? ""))
        .join("\t");
    })
    .join("\n")}${value.length ? "\n" : ""}`;
}

function plainOutput(command: LaneCliCommand, value: unknown): string {
  if (["models", "providers-list", "activity"].includes(command)) return tabular(value);
  if (command === "connection") {
    const connection = value as {
      api_base_url: string;
      client_key: string;
      endpoints: Array<{ method: string; name: string; url: string }>;
    };
    return [
      `api_base_url\t${connection.api_base_url}`,
      `client_key\t${connection.client_key}`,
      ...connection.endpoints.map(
        (endpoint) => `endpoint\t${endpoint.method}\t${endpoint.name}\t${endpoint.url}`,
      ),
      "",
    ].join("\n");
  }
  if (command === "status") {
    const status = value as {
      gateway: { running: boolean; api_base_url: string };
      default_model: string | null;
      default_image_model: string | null;
      providers: { connected: number; total: number };
    };
    return [
      `gateway.running\t${String(status.gateway.running)}`,
      `gateway.api_base_url\t${status.gateway.api_base_url}`,
      `default_model\t${status.default_model ?? ""}`,
      `default_image_model\t${status.default_image_model ?? ""}`,
      `providers.connected\t${String(status.providers.connected)}`,
      `providers.total\t${String(status.providers.total)}`,
      "",
    ].join("\n");
  }
  return `${command}\tok\n`;
}

function humanOutput(command: LaneCliCommand, value: unknown): string {
  if (command === "status") return humanStatus(value);
  if (command === "models") {
    const models = value as Array<{ id: string; name: string }>;
    return models.length
      ? `${models.map((model) => `${model.id}\t${model.name}`).join("\n")}\n`
      : "No models available.\n";
  }
  if (command === "providers-list") {
    const providers = value as Array<{ id: string; name: string; connected: boolean }>;
    return providers.length
      ? `${providers
          .map((provider) => `${provider.id}\t${provider.name}\t${provider.connected ? "connected" : "disconnected"}`)
          .join("\n")}\n`
      : "No providers configured.\n";
  }
  if (command === "activity") return tabular(value) || "No recent activity.\n";
  if (command === "connection") {
    const connection = value as { api_base_url: string; client_key: string };
    return `API base URL: ${connection.api_base_url}\nLane client key: ${connection.client_key}\n`;
  }
  const messages: Partial<Record<LaneCliCommand, string>> = {
    start: "Gateway started.",
    stop: "Gateway stopped.",
    open: "Lane opened.",
    "providers-add": "Provider connected.",
    "providers-remove": "Provider removed.",
    "providers-oauth": "ChatGPT / Codex connected.",
    "models-set-default": "Default model updated.",
    "models-set-default-image": "Image model updated.",
  };
  return `${messages[command] ?? "Done."}\n`;
}

async function defaultReadStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

async function controlRequest(
  parsed: ParsedCli,
  options: LaneCliOptions,
): Promise<Omit<CliControlRequest, "version">> {
  switch (parsed.command) {
    case "providers-add": {
      if (!parsed.kind || !["openai", "anthropic", "openrouter", "custom-openai"].includes(parsed.kind)) {
        throw new Error("--kind must be openai, anthropic, openrouter, or custom-openai");
      }
      if (!parsed.apiKeyStdin) {
        throw new Error("Provider API keys must be supplied with --api-key-stdin");
      }
      if (parsed.kind === "custom-openai" && !parsed.baseUrl) {
        throw new Error("--base-url is required for custom-openai");
      }
      const apiKey = (await (options.readStdin ?? defaultReadStdin)()).trim();
      if (!apiKey) throw new Error("No API key was received on stdin");
      return {
        command: "providers-add",
        params: {
          provider: {
            kind: parsed.kind as "openai" | "anthropic" | "openrouter" | "custom-openai",
            apiKey,
            ...(parsed.name ? { name: parsed.name } : {}),
            ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
          },
        },
      };
    }
    case "providers-remove":
      if (!parsed.id) throw new Error("--id is required");
      if (!parsed.force) throw new Error("providers remove requires --force");
      return { command: "providers-remove", params: { providerId: parsed.id } };
    case "models-set-default":
      if (!parsed.id) throw new Error("--id is required");
      return { command: "default-model-set", params: { modelId: parsed.id } };
    case "models-set-default-image":
      if (!parsed.id) throw new Error("--id is required");
      return { command: "default-image-model-set", params: { modelId: parsed.id } };
    case "providers-list":
      return { command: "providers-list" };
    case "providers-oauth":
      return { command: "providers-oauth" };
    case "connection":
      return { command: "connection" };
    case "activity":
      return { command: "activity" };
    case "models":
      return { command: "models" };
    case "status":
    case "start":
    case "stop":
    case "open":
      return { command: parsed.command };
    default:
      throw new Error("Command cannot be sent to Lane");
  }
}

function isUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code ?? "");
}

function requestTimeout(request: Omit<CliControlRequest, "version">): number {
  if (request.command === "providers-oauth") return 10 * 60_000;
  if (request.command === "providers-add") return 60_000;
  return 5_000;
}

async function requestWithWake(
  requestValue: Omit<CliControlRequest, "version">,
  options: LaneCliOptions,
  mode: OutputMode,
  io: LaneCliIo,
): Promise<CliControlResponse> {
  const request = options.request ?? requestCliControl;
  try {
    return await request(options.socketPath, requestValue, requestTimeout(requestValue));
  } catch (error) {
    if (!options.wakeApp || !isUnavailable(error)) throw error;
  }

  if (mode === "human" && io.isTTY) io.stderr("Starting Lane…\n");
  await options.wakeApp();
  const deadline = Date.now() + 4_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await request(options.socketPath, requestValue, requestTimeout(requestValue));
    } catch (error) {
      lastError = error;
      if (!isUnavailable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Lane is not available");
}

export function isLaneCliInvocation(args: string[]): boolean {
  return args.some(
    (arg) =>
      (TOP_LEVEL_COMMANDS as readonly string[]).includes(arg) ||
      ["-h", "--help", "-V", "--version"].includes(arg),
  );
}

export async function runLaneCli(args: string[], options: LaneCliOptions): Promise<number> {
  const io: LaneCliIo = options.io ?? {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    isTTY: process.stdout.isTTY === true,
  };

  let parsed: ParsedCli;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    writeError(
      io,
      args.includes("--json") ? "json" : "human",
      errorPayload("INVALID_USAGE", error instanceof Error ? error.message : String(error), false, "Run lane --help."),
    );
    return 2;
  }

  if (parsed.version) {
    io.stdout(`${options.version}\n`);
    return 0;
  }
  if (parsed.help || !parsed.command) {
    io.stdout(HELP);
    return 0;
  }
  if (parsed.command === "schema") {
    io.stdout(`${JSON.stringify(LANE_CLI_SCHEMA, null, parsed.mode === "json" ? 0 : 2)}\n`);
    return 0;
  }

  try {
    const request = await controlRequest(parsed, options);
    const response = await requestWithWake(request, options, parsed.mode, io);
    if (!response.ok) {
      writeError(
        io,
        parsed.mode,
        errorPayload(response.error.code, response.error.message, response.error.retryable, "Open Lane to review the relevant connection or gateway status, then retry."),
      );
      return response.error.retryable ? 8 : 1;
    }
    if (parsed.mode === "json") io.stdout(`${JSON.stringify(response.data)}\n`);
    else if (parsed.mode === "plain") io.stdout(plainOutput(parsed.command, response.data));
    else io.stdout(humanOutput(parsed.command, response.data));
    return 0;
  } catch (error) {
    const usageError =
      error instanceof Error &&
      (error.message.startsWith("--") ||
        error.message.includes("requires --force") ||
        error.message.includes("stdin"));
    writeError(
      io,
      parsed.mode,
      errorPayload(
        usageError ? "INVALID_USAGE" : "CLI_INTEGRATION_UNAVAILABLE",
        error instanceof Error ? error.message : "Lane CLI integration is unavailable.",
        false,
        usageError ? "Run lane --help." : "Open Lane → Settings → Command line → Install…, then retry.",
      ),
    );
    return usageError ? 2 : 4;
  }
}
