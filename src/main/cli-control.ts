import { createHash } from "node:crypto";
import { isE2eControlAction, type E2eControlParams } from "../shared/e2e-control.ts";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type {
  AddProviderInput,
  ReasoningEffort,
  SpeedMode,
} from "../shared/contracts.ts";

export const CLI_PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 16 * 1024;

export type CliControlCommand =
  | "status"
  | "start"
  | "stop"
  | "open"
  | "models"
  | "connection"
  | "activity"
  | "providers-list"
  | "providers-add"
  | "providers-remove"
  | "providers-oauth"
  | "default-model-set"
  | "default-image-model-set"
  | "reasoning-effort-set"
  | "speed-mode-set"
  | "browser-client-connect"
  // Registered only in E2E mode; see e2e-control.ts.
  | "e2e"
  | "quit";

export interface CliControlRequest {
  version: typeof CLI_PROTOCOL_VERSION;
  command: CliControlCommand;
  params?: {
    provider?: AddProviderInput;
    providerId?: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort;
    speedMode?: SpeedMode;
    origin?: string;
    e2e?: E2eControlParams;
  };
}

export interface CliControlSuccess {
  ok: true;
  data: unknown;
}

export interface CliControlFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type CliControlResponse = CliControlSuccess | CliControlFailure;

export interface CliControlHandler {
  execute(request: CliControlRequest): Promise<unknown>;
}

export function getCliSocketPath(userDataPath: string): string {
  if (process.platform !== "win32") return join(userDataPath, "lane-control.sock");
  const identity = createHash("sha256").update(userDataPath).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\lane-${identity}`;
}

function isCommand(value: unknown): value is CliControlCommand {
  return [
    "status",
    "start",
    "stop",
    "open",
    "models",
    "connection",
    "activity",
    "providers-list",
    "providers-add",
    "providers-remove",
    "providers-oauth",
    "default-model-set",
    "default-image-model-set",
    "reasoning-effort-set",
    "speed-mode-set",
    "browser-client-connect",
    "e2e",
    "quit",
  ].includes(String(value));
}

function parseRequest(value: unknown): CliControlRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid request");
  const request = value as Partial<CliControlRequest>;
  if (request.version !== CLI_PROTOCOL_VERSION) {
    throw new Error("Unsupported CLI protocol version");
  }
  if (!isCommand(request.command)) throw new Error("Unsupported CLI command");
  const params =
    request.params && typeof request.params === "object"
      ? request.params
      : undefined;
  if (request.command === "providers-add") {
    const provider = params?.provider;
    const kinds = ["claude-code", "openai", "anthropic", "openrouter", "custom-openai"];
    if (!provider || !kinds.includes(provider.kind)) {
      throw new Error("Invalid provider input");
    }
    if (
      provider.kind !== "claude-code" &&
      (typeof provider.apiKey !== "string" || !provider.apiKey.trim())
    ) {
      throw new Error("Invalid provider input");
    }
  }
  if (
    request.command === "providers-remove" &&
    (typeof params?.providerId !== "string" || !params.providerId)
  ) {
    throw new Error("Provider id is required");
  }
  if (
    (request.command === "default-model-set" ||
      request.command === "default-image-model-set") &&
    (typeof params?.modelId !== "string" || !params.modelId)
  ) {
    throw new Error("Model id is required");
  }
  if (
    request.command === "browser-client-connect" &&
    (typeof params?.origin !== "string" || !params.origin)
  ) {
    throw new Error("Browser extension origin is required");
  }
  if (
    request.command === "reasoning-effort-set" &&
    !["low", "medium", "high", "xhigh", "max"].includes(
      params?.reasoningEffort ?? "",
    )
  ) {
    throw new Error("Effort must be low, medium, high, xhigh, or max");
  }
  if (
    request.command === "e2e" &&
    !isE2eControlAction(params?.e2e?.action)
  ) {
    throw new Error("Unsupported E2E action");
  }
  if (
    request.command === "speed-mode-set" &&
    params?.speedMode !== "standard" &&
    params?.speedMode !== "fast"
  ) {
    throw new Error("Speed must be standard or fast");
  }
  return {
    version: CLI_PROTOCOL_VERSION,
    command: request.command,
    ...(params ? { params } : {}),
  };
}

function writeResponse(socket: Socket, response: CliControlResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const entry = await lstat(socketPath);
    if (!entry.isSocket()) throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class LaneCliControlServer {
  private server: Server | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly handler: CliControlHandler,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (process.platform !== "win32") {
      await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    }
    await removeStaleSocket(this.socketPath);

    const server = createServer((socket) => {
      socket.setTimeout(5_000, () => socket.destroy());
      let body = "";
      let handled = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        if (handled) return;
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
          handled = true;
          writeResponse(socket, {
            ok: false,
            error: {
              code: "REQUEST_TOO_LARGE",
              message: "CLI control request is too large",
              retryable: false,
            },
          });
          return;
        }
        const newline = body.indexOf("\n");
        if (newline === -1) return;
        handled = true;
        socket.setTimeout(0);
        void this.respond(socket, body.slice(0, newline));
      });
      socket.on("error", () => {});
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });

    if (process.platform !== "win32") await chmod(this.socketPath, 0o600);
    this.server = server;
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    try {
      const request = parseRequest(JSON.parse(line));
      writeResponse(socket, {
        ok: true,
        data: await this.handler.execute(request),
      });
    } catch (error) {
      writeResponse(socket, {
        ok: false,
        error: {
          code: "CONTROL_ERROR",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      });
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== "win32") {
      try {
        await unlink(this.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export async function requestCliControl(
  socketPath: string,
  command: CliControlCommand | Omit<CliControlRequest, "version">,
  timeoutMs = 2_000,
): Promise<CliControlResponse> {
  return await new Promise<CliControlResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for Lane")));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const request: CliControlRequest =
        typeof command === "string"
          ? { version: CLI_PROTOCOL_VERSION, command }
          : {
              version: CLI_PROTOCOL_VERSION,
              command: command.command,
              ...(command.params ? { params: command.params } : {}),
            };
      socket.write(
        `${JSON.stringify(request)}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      finish(() => {
        try {
          resolve(JSON.parse(body.slice(0, newline)) as CliControlResponse);
        } catch {
          reject(new Error("Lane returned an invalid control response"));
        }
      });
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("end", () => {
      if (!settled) finish(() => reject(new Error("Lane closed the control connection")));
    });
  });
}
