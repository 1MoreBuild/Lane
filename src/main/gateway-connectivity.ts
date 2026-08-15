import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  GatewayConnectivityProbe,
  GatewayConnectivityResult,
} from "../shared/contracts.ts";

const execFileAsync = promisify(execFile);
const DESKTOP_TIMEOUT_MS = 3_000;
const MODEL_TIMEOUT_MS = 45_000;
const WSL_TIMEOUT_MS = 5_000;

interface GatewayConnectivityDependencies {
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  runWsl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  now?: () => number;
}

function healthUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  ) {
    throw new Error("Gateway connectivity checks require a loopback HTTP endpoint");
  }
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function responsesUrl(endpoint: string): string {
  const url = new URL(healthUrl(endpoint));
  url.pathname = "/v1/responses";
  return url.toString();
}

async function defaultRunWsl(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("wsl.exe", args, {
    encoding: "utf8",
    timeout: WSL_TIMEOUT_MS,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function cleanWslOutput(output: string): string {
  return output.replaceAll("\0", "").replace(/^\uFEFF/, "").trim();
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { message?: unknown; stderr?: unknown };
  return `${String(value.message ?? "")}\n${String(value.stderr ?? "")}`;
}

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { code?: string | number }).code;
}

async function probeDesktop(
  url: string,
  clientKey: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<GatewayConnectivityProbe> {
  const startedAt = now();
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${clientKey}` },
      signal: AbortSignal.timeout(DESKTOP_TIMEOUT_MS),
    });
    const latencyMs = Math.max(0, now() - startedAt);
    if (response.status === 200) {
      return { status: "reachable", latencyMs };
    }
    if (response.status === 401) {
      return { status: "unreachable", latencyMs, reason: "authentication_failed" };
    }
    return { status: "unreachable", latencyMs, reason: "unexpected_response" };
  } catch {
    return {
      status: "unreachable",
      latencyMs: Math.max(0, now() - startedAt),
      reason: "connection_failed",
    };
  }
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

async function probeModel(
  url: string,
  clientKey: string,
  model: string | undefined,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<GatewayConnectivityProbe> {
  if (!model) {
    return { status: "unavailable", reason: "model_not_configured" };
  }

  const startedAt = now();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: "Reply with exactly OK.",
        max_output_tokens: 32,
        reasoning: { effort: "low" },
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    const latencyMs = Math.max(0, now() - startedAt);
    if (response.ok) return { status: "reachable", latencyMs };
    if (response.status === 401 || response.status === 403) {
      return { status: "unreachable", latencyMs, reason: "authentication_failed" };
    }
    if (response.status === 404) {
      return { status: "unreachable", latencyMs, reason: "model_not_found" };
    }
    if (response.status === 429) {
      return { status: "unreachable", latencyMs, reason: "rate_limited" };
    }
    if (response.status >= 500) {
      return { status: "unreachable", latencyMs, reason: "provider_unavailable" };
    }
    return { status: "unreachable", latencyMs, reason: "unexpected_response" };
  } catch (error) {
    return {
      status: "unreachable",
      latencyMs: Math.max(0, now() - startedAt),
      reason: isTimeoutError(error) ? "request_timeout" : "connection_failed",
    };
  }
}

async function probeWsl(
  url: string,
  runWsl: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  now: () => number,
): Promise<GatewayConnectivityProbe> {
  let distributions: string[];
  try {
    const result = await runWsl(["--list", "--running", "--quiet"]);
    distributions = cleanWslOutput(result.stdout)
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return { status: "unavailable", reason: "wsl_unavailable" };
  }

  const environment = distributions[0];
  if (!environment) {
    return { status: "unavailable", reason: "wsl_not_running" };
  }

  const startedAt = now();
  try {
    const result = await runWsl([
      "--distribution",
      environment,
      "--exec",
      "curl",
      "--silent",
      "--show-error",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "--connect-timeout",
      "2",
      url,
    ]);
    const statusCode = cleanWslOutput(result.stdout);
    if (/^[1-5]\d{2}$/.test(statusCode)) {
      return {
        status: "reachable",
        latencyMs: Math.max(0, now() - startedAt),
        environment,
      };
    }
    return {
      status: "unavailable",
      reason: "probe_tool_missing",
      environment,
    };
  } catch (error) {
    const text = errorText(error);
    const code = errorCode(error);
    if (
      code === "ENOENT" ||
      code === 127 ||
      /(?:command not found|not recognized|executable file not found)/i.test(text)
    ) {
      return {
        status: "unavailable",
        reason: "probe_tool_missing",
        environment,
      };
    }
    return {
      status: "unreachable",
      latencyMs: Math.max(0, now() - startedAt),
      reason: "connection_failed",
      environment,
    };
  }
}

export async function testGatewayConnectivity(
  endpoint: string,
  clientKey: string,
  defaultModel?: string,
  dependencies: GatewayConnectivityDependencies = {},
): Promise<GatewayConnectivityResult> {
  const platform = dependencies.platform ?? process.platform;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const runWsl = dependencies.runWsl ?? defaultRunWsl;
  const now = dependencies.now ?? Date.now;
  const url = healthUrl(endpoint);

  const [desktop, wsl] = await Promise.all([
    probeDesktop(url, clientKey, fetchImpl, now),
    platform === "win32" ? probeWsl(url, runWsl, now) : undefined,
  ]);
  const model = desktop.status === "reachable"
    ? await probeModel(responsesUrl(endpoint), clientKey, defaultModel, fetchImpl, now)
    : { status: "unreachable" as const, reason: "gateway_unavailable" as const };

  return {
    checkedAt: now(),
    desktop,
    model,
    ...(wsl ? { wsl } : {}),
  };
}
