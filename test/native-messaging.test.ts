import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  encodeNativeMessage,
  runLaneNativeHost,
} from "../src/main/native-messaging.ts";
import { NativeMessagingInstaller } from "../src/main/native-messaging-install.ts";
import {
  LANE_NATIVE_HOST_NAME,
  LANE_NATIVE_PROTOCOL_VERSION,
  TRANSLY_EXTENSION_ORIGINS,
  TRANSLY_NATIVE_ALLOWED_ORIGINS,
  TRANSLY_PRODUCTION_EXTENSION_ID,
} from "../src/shared/native-messaging.ts";
import { tempPath } from "./helpers.ts";

function decodeFrame(frame: Buffer) {
  const length = frame.readUInt32LE(0);
  return JSON.parse(frame.subarray(4, length + 4).toString("utf8"));
}

describe("Lane native messaging", () => {
  it("returns only the Lane client connection to the approved Transly origin", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    input.end(encodeNativeMessage({
      protocolVersion: LANE_NATIVE_PROTOCOL_VERSION,
      type: "connect",
    }));
    const connect = vi.fn(async () => ({
      ok: true as const,
      data: {
        service: "lane",
        apiUrl: "http://127.0.0.1:3210/v1",
        apiKey: "lane-client-key",
        models: ["openai-codex/gpt-test"],
        defaultModel: "openai-codex/gpt-test",
        protocol: "responses",
      },
    }));

    await expect(runLaneNativeHost({
      callerOrigin: TRANSLY_NATIVE_ALLOWED_ORIGINS[0],
      stdin: input,
      stdout: output,
      connect,
    })).resolves.toBe(0);
    expect(connect).toHaveBeenCalledWith(
      `chrome-extension://${TRANSLY_PRODUCTION_EXTENSION_ID}/`,
    );
    expect(decodeFrame(Buffer.concat(chunks))).toMatchObject({
      protocolVersion: LANE_NATIVE_PROTOCOL_VERSION,
      ok: true,
      data: {
        apiUrl: "http://127.0.0.1:3210/v1",
        apiKey: "lane-client-key",
        models: ["openai-codex/gpt-test"],
      },
    });
  });

  it("does not expose internal connection errors to the extension", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    input.end(encodeNativeMessage({
      protocolVersion: LANE_NATIVE_PROTOCOL_VERSION,
      type: "connect",
    }));

    const onError = vi.fn();
    await expect(runLaneNativeHost({
      callerOrigin: TRANSLY_NATIVE_ALLOWED_ORIGINS[0],
      stdin: input,
      stdout: output,
      onError,
      connect: async () => {
        throw new Error("connect ENOENT /Users/example/private/lane-control.sock");
      },
    })).resolves.toBe(1);
    expect(decodeFrame(Buffer.concat(chunks))).toMatchObject({
      ok: false,
      error: {
        code: "LANE_UNAVAILABLE",
        message: "Lane is unavailable.",
      },
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "connect ENOENT /Users/example/private/lane-control.sock",
      }),
    );
  });

  it("rejects every caller except the registered Transly extension", async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const connect = vi.fn();
    await expect(runLaneNativeHost({
      callerOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      stdin: new PassThrough(),
      stdout: output,
      connect,
    })).resolves.toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(decodeFrame(Buffer.concat(chunks))).toMatchObject({
      ok: false,
      error: { code: "CALLER_NOT_ALLOWED" },
    });
  });

  it("installs a Chrome host manifest scoped to the explicit Transly allowlist", async () => {
    const homePath = dirname(await tempPath("home-marker"));
    const userDataPath = await tempPath("user-data");
    const executablePath = "/Applications/Lane.app/Contents/MacOS/Lane";
    const installer = new NativeMessagingInstaller({
      executablePath,
      platform: "darwin",
      homePath,
      userDataPath,
    });
    const state = await installer.install();
    expect(state.installed).toBe(true);
    const manifest = JSON.parse(await readFile(state.manifestPath!, "utf8"));
    if (process.platform !== "win32") {
      expect((await stat(state.manifestPath!)).mode & 0o777).toBe(0o600);
    }
    expect(manifest).toEqual({
      name: LANE_NATIVE_HOST_NAME,
      description: "Connect approved browser extensions to the Lane local AI gateway",
      path: resolve(executablePath),
      type: "stdio",
      allowed_origins: TRANSLY_NATIVE_ALLOWED_ORIGINS,
    });
    expect(TRANSLY_EXTENSION_ORIGINS).toEqual([
      `chrome-extension://${TRANSLY_PRODUCTION_EXTENSION_ID}`,
    ]);
    expect(TRANSLY_NATIVE_ALLOWED_ORIGINS).toEqual([
      `chrome-extension://${TRANSLY_PRODUCTION_EXTENSION_ID}/`,
    ]);
  });
});
