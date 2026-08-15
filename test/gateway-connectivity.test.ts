import { describe, expect, it, vi } from "vitest";

import { testGatewayConnectivity } from "../src/main/gateway-connectivity.ts";

describe("gateway connectivity checks", () => {
  it("authenticates the desktop health check without probing WSL on macOS", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    const result = await testGatewayConnectivity(
      "http://127.0.0.1:3210",
      "lane-key",
      "provider/model",
      { platform: "darwin", fetchImpl, now: () => 100 },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer lane-key" },
      }),
    );
    expect(result.desktop).toEqual({ status: "reachable", latencyMs: 0 });
    expect(result.model).toEqual({ status: "reachable", latencyMs: 0 });
    expect(result.wsl).toBeUndefined();
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "http://127.0.0.1:3210/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer lane-key",
        }),
      }),
    );
  });

  it("reports an authentication failure separately from a network failure", async () => {
    const unauthorized = await testGatewayConnectivity(
      "http://127.0.0.1:3210",
      "wrong-key",
      "provider/model",
      {
        platform: "linux",
        fetchImpl: async () => new Response(null, { status: 401 }),
        now: () => 100,
      },
    );
    const offline = await testGatewayConnectivity(
      "http://127.0.0.1:3210",
      "lane-key",
      "provider/model",
      {
        platform: "linux",
        fetchImpl: async () => {
          throw new Error("connection refused");
        },
        now: () => 100,
      },
    );

    expect(unauthorized.desktop.reason).toBe("authentication_failed");
    expect(unauthorized.model.reason).toBe("gateway_unavailable");
    expect(offline.desktop.reason).toBe("connection_failed");
  });

  it("requires a real default-model response before reporting the full path as ready", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/health")
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 429 }),
    );
    const result = await testGatewayConnectivity(
      "http://127.0.0.1:3210",
      "lane-key",
      "provider/model",
      { platform: "darwin", fetchImpl, now: () => 100 },
    );

    expect(result.desktop.status).toBe("reachable");
    expect(result.model).toEqual({
      status: "unreachable",
      latencyMs: 0,
      reason: "rate_limited",
    });
  });

  it("does not claim readiness when no default model is configured", async () => {
    const result = await testGatewayConnectivity(
      "http://127.0.0.1:3210",
      "lane-key",
      undefined,
      {
        platform: "darwin",
        fetchImpl: async () => new Response(null, { status: 200 }),
        now: () => 100,
      },
    );

    expect(result.model).toEqual({
      status: "unavailable",
      reason: "model_not_configured",
    });
  });

  it("detects a running WSL distribution that can reach Windows localhost", async () => {
    const runWsl = vi.fn(async (args: string[]) =>
      args.includes("--list")
        ? { stdout: "Ubuntu-24.04\r\n", stderr: "" }
        : { stdout: "401", stderr: "" },
    );
    const result = await testGatewayConnectivity(
      "http://127.0.0.1:3210",
      "lane-key",
      "provider/model",
      {
        platform: "win32",
        fetchImpl: async () => new Response(null, { status: 200 }),
        runWsl,
        now: () => 100,
      },
    );

    expect(result.wsl).toEqual({
      status: "reachable",
      latencyMs: 0,
      environment: "Ubuntu-24.04",
    });
    expect(runWsl).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        "--distribution",
        "Ubuntu-24.04",
        "--exec",
        "curl",
        "http://127.0.0.1:3210/health",
      ]),
    );
  });

  it("distinguishes stopped WSL from an unreachable Windows localhost", async () => {
    const stopped = await testGatewayConnectivity(
      "http://127.0.0.1:3210",
      "lane-key",
      "provider/model",
      {
        platform: "win32",
        fetchImpl: async () => new Response(null, { status: 200 }),
        runWsl: async () => ({ stdout: "", stderr: "" }),
        now: () => 100,
      },
    );
    const unreachable = await testGatewayConnectivity(
      "http://127.0.0.1:3210",
      "lane-key",
      "provider/model",
      {
        platform: "win32",
        fetchImpl: async () => new Response(null, { status: 200 }),
        runWsl: async (args) => {
          if (args.includes("--list")) {
            return { stdout: "Ubuntu-24.04\n", stderr: "" };
          }
          throw Object.assign(new Error("curl failed"), { code: 7 });
        },
        now: () => 100,
      },
    );

    expect(stopped.wsl).toEqual({
      status: "unavailable",
      reason: "wsl_not_running",
    });
    expect(unreachable.wsl).toEqual({
      status: "unreachable",
      latencyMs: 0,
      reason: "connection_failed",
      environment: "Ubuntu-24.04",
    });
  });
});
