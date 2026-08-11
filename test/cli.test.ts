import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  installCliOutputErrorHandlers,
  runLaneCli,
  type LaneCliIo,
} from "../src/main/cli.ts";
import type { CliControlResponse } from "../src/main/cli-control.ts";

function capture(): {
  io: LaneCliIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      isTTY: false,
    },
  };
}

const status: CliControlResponse = {
  ok: true,
  data: {
    version: "0.1.0",
    gateway: { running: true, api_base_url: "http://127.0.0.1:3210/v1" },
    default_model: "openai-codex/gpt-5.6-sol",
    default_image_model: "openai-codex/gpt-image-2",
    reasoning_effort: "high",
    speed_mode: "standard",
    providers: { connected: 1, total: 1 },
  },
};

describe("Lane CLI", () => {
  it("exits quietly when a caller closes the output pipe", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const onBrokenPipe = vi.fn();
    const removeHandlers = installCliOutputErrorHandlers(onBrokenPipe, [
      stdout,
      stderr,
    ]);

    stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    stderr.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));

    expect(onBrokenPipe).toHaveBeenCalledOnce();
    removeHandlers();
  });

  it("does not swallow unexpected output errors", () => {
    const stdout = new PassThrough();
    const removeHandlers = installCliOutputErrorHandlers(() => {}, [stdout]);

    expect(() => stdout.emit("error", new Error("unexpected"))).toThrow(
      "unexpected",
    );
    removeHandlers();
  });

  it("prints strict JSON status for agents", async () => {
    const output = capture();
    const code = await runLaneCli(["status", "--json", "--no-input"], {
      socketPath: "unused",
      version: "0.1.0",
      io: output.io,
      request: async () => status,
    });
    expect(code).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toEqual(status.data);
    expect(output.stderr).toEqual([]);
  });

  it("prints stable line-oriented models", async () => {
    const output = capture();
    const code = await runLaneCli(["models", "--plain"], {
      socketPath: "unused",
      version: "0.1.0",
      io: output.io,
      request: async () => ({
        ok: true,
        data: [{ id: "openai-codex/gpt", name: "GPT", provider: "openai-codex" }],
      }),
    });
    expect(code).toBe(0);
    expect(output.stdout.join("")).toBe(
      "openai-codex/gpt\tGPT\topenai-codex\n",
    );
  });

  it("wakes Lane once and retries when the service is absent", async () => {
    const output = capture();
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const request = vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(status);
    const wakeApp = vi.fn(async () => {});
    const code = await runLaneCli(["status", "--json"], {
      socketPath: "unused",
      version: "0.1.0",
      io: output.io,
      request,
      wakeApp,
    });
    expect(code).toBe(0);
    expect(wakeApp).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns connection details including the Lane client key", async () => {
    const output = capture();
    const code = await runLaneCli(["connection", "--json", "--no-input"], {
      socketPath: "unused",
      version: "0.1.0",
      io: output.io,
      request: async () => ({
        ok: true,
        data: {
          api_base_url: "http://127.0.0.1:3210/v1",
          client_key: "lane-client-key",
          endpoints: [],
        },
      }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toEqual({
      api_base_url: "http://127.0.0.1:3210/v1",
      client_key: "lane-client-key",
      endpoints: [],
    });
  });

  it("sets the default image model through the agent-facing control protocol", async () => {
    const output = capture();
    const request = vi.fn(async () => ({
      ok: true as const,
      data: { default_image_model: "openai-codex/gpt-image-2" },
    }));
    const code = await runLaneCli(
      [
        "models",
        "set-default-image",
        "--id",
        "openai-codex/gpt-image-2",
        "--json",
        "--no-input",
      ],
      {
        socketPath: "unused",
        version: "0.1.0",
        io: output.io,
        request,
      },
    );
    expect(code).toBe(0);
    expect(request).toHaveBeenCalledWith(
      "unused",
      {
        command: "default-image-model-set",
        params: { modelId: "openai-codex/gpt-image-2" },
      },
      5_000,
    );
  });

  it("sets Standard or Fast through the agent-facing control protocol", async () => {
    const output = capture();
    const request = vi.fn(async () => ({
      ok: true as const,
      data: { speed_mode: "fast" },
    }));
    const code = await runLaneCli(
      ["models", "set-speed", "--speed", "fast", "--json", "--no-input"],
      {
        socketPath: "unused",
        version: "0.1.0",
        io: output.io,
        request,
      },
    );
    expect(code).toBe(0);
    expect(request).toHaveBeenCalledWith(
      "unused",
      { command: "speed-mode-set", params: { speedMode: "fast" } },
      5_000,
    );
  });

  it("sets reasoning effort through the agent-facing control protocol", async () => {
    const output = capture();
    const request = vi.fn(async () => ({
      ok: true as const,
      data: { reasoning_effort: "max" },
    }));
    const code = await runLaneCli(
      ["models", "set-effort", "--effort", "max", "--json", "--no-input"],
      {
        socketPath: "unused",
        version: "0.1.0",
        io: output.io,
        request,
      },
    );
    expect(code).toBe(0);
    expect(request).toHaveBeenCalledWith(
      "unused",
      { command: "reasoning-effort-set", params: { reasoningEffort: "max" } },
      5_000,
    );
  });

  it("reads provider API keys from stdin and never accepts them as flags", async () => {
    const output = capture();
    const request = vi.fn(async () => ({
      ok: true as const,
      data: { providers: [] },
    }));
    const code = await runLaneCli(
      [
        "providers",
        "add",
        "--kind",
        "openai",
        "--name",
        "Work",
        "--api-key-stdin",
        "--json",
      ],
      {
        socketPath: "unused",
        version: "0.1.0",
        io: output.io,
        readStdin: async () => "sk-test-secret\n",
        request,
      },
    );
    expect(code).toBe(0);
    expect(request).toHaveBeenCalledWith(
      "unused",
      {
        command: "providers-add",
        params: {
          provider: {
            kind: "openai",
            name: "Work",
            apiKey: "sk-test-secret",
          },
        },
      },
      60_000,
    );
    expect(output.stdout.join("")).not.toContain("sk-test-secret");
  });

  it("requires force before removing a provider", async () => {
    const output = capture();
    const request = vi.fn();
    const code = await runLaneCli(
      ["providers", "remove", "--id", "provider-1", "--json", "--no-input"],
      {
        socketPath: "unused",
        version: "0.1.0",
        io: output.io,
        request,
      },
    );
    expect(code).toBe(2);
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr.join(""))).toMatchObject({
      error: "INVALID_USAGE",
    });
  });

  it("uses semantic JSON errors without prompting", async () => {
    const output = capture();
    const code = await runLaneCli(["status", "--json"], {
      socketPath: "unused",
      version: "0.1.0",
      io: output.io,
      request: async () => {
        throw new Error("missing");
      },
    });
    expect(code).toBe(4);
    expect(JSON.parse(output.stderr.join(""))).toMatchObject({
      error: "CLI_INTEGRATION_UNAVAILABLE",
      retryable: false,
    });
    expect(output.stdout).toEqual([]);
  });

  it("publishes a machine-readable command schema", async () => {
    const output = capture();
    const code = await runLaneCli(["schema", "--json"], {
      socketPath: "unused",
      version: "0.1.0",
      io: output.io,
    });
    expect(code).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      name: "lane",
      version: 1,
      commands: {
        start: { mutation: true, idempotent: true },
        models: { mutation: false },
      },
    });
  });
});
