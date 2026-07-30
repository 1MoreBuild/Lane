import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import {
  CLI_PROTOCOL_VERSION,
  getCliSocketPath,
  LaneCliControlServer,
  requestCliControl,
  type CliControlResponse,
} from "../src/main/cli-control.ts";
import { tempPath } from "./helpers.ts";

async function testSocketPath(): Promise<string> {
  return getCliSocketPath(await tempPath("user-data"));
}

async function rawRequest(socketPath: string, value: string): Promise<CliControlResponse> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${value}\n`));
    socket.on("data", (chunk: string) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline !== -1) {
        socket.destroy();
        resolve(JSON.parse(body.slice(0, newline)) as CliControlResponse);
      }
    });
    socket.on("error", reject);
  });
}

describe("CLI control socket", () => {
  it("accepts allowlisted commands over a private local socket", async () => {
    const socketPath = await testSocketPath();
    const commands: string[] = [];
    const server = new LaneCliControlServer(socketPath, {
      execute: async (request) => {
        commands.push(request.command);
        return { gateway: { running: true } };
      },
    });

    await server.start();
    try {
      if (process.platform !== "win32") {
        expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
      }
      await expect(requestCliControl(socketPath, "status")).resolves.toEqual({
        ok: true,
        data: { gateway: { running: true } },
      });
      expect(commands).toEqual(["status"]);
    } finally {
      await server.stop();
    }
  });

  it("rejects unknown commands and protocol versions", async () => {
    const socketPath = await testSocketPath();
    const server = new LaneCliControlServer(socketPath, {
      execute: async () => {
        throw new Error("must not execute");
      },
    });
    await server.start();
    try {
      const command = await rawRequest(
        socketPath,
        JSON.stringify({ version: CLI_PROTOCOL_VERSION, command: "remove-provider" }),
      );
      expect(command).toMatchObject({
        ok: false,
        error: { code: "CONTROL_ERROR", retryable: false },
      });

      const version = await rawRequest(
        socketPath,
        JSON.stringify({ version: 999, command: "status" }),
      );
      expect(version).toMatchObject({
        ok: false,
        error: { code: "CONTROL_ERROR", retryable: false },
      });
    } finally {
      await server.stop();
    }
  });
});
