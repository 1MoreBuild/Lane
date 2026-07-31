import type { Readable, Writable } from "node:stream";
import type { CliControlResponse } from "./cli-control.ts";
import {
  isAllowedTranslyExtensionOrigin,
  LANE_NATIVE_PROTOCOL_VERSION,
  type LaneNativeConnectRequest,
  type LaneNativeConnection,
  type LaneNativeResponse,
} from "../shared/native-messaging.ts";

const MAX_REQUEST_BYTES = 64 * 1024;

export interface LaneNativeHostOptions {
  callerOrigin: string;
  stdin?: Readable;
  stdout?: Writable;
  connect(): Promise<CliControlResponse>;
}

export function encodeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export async function readNativeMessage(input: Readable): Promise<unknown> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffer.length < 4) continue;
    const length = buffer.readUInt32LE(0);
    if (length > MAX_REQUEST_BYTES) throw new Error("Native message is too large");
    if (buffer.length < length + 4) continue;
    return JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
  }
  throw new Error("Chrome closed the native messaging channel");
}

function parseConnectRequest(value: unknown): LaneNativeConnectRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid native message");
  const request = value as Partial<LaneNativeConnectRequest>;
  if (request.protocolVersion !== LANE_NATIVE_PROTOCOL_VERSION || request.type !== "connect") {
    throw new Error("Unsupported native messaging request");
  }
  return request as LaneNativeConnectRequest;
}

function failure(code: string, message: string, retryable = false): LaneNativeResponse {
  return {
    protocolVersion: LANE_NATIVE_PROTOCOL_VERSION,
    ok: false,
    error: { code, message, retryable },
  };
}

export async function runLaneNativeHost(options: LaneNativeHostOptions): Promise<number> {
  const output = options.stdout ?? process.stdout;
  let response: LaneNativeResponse;
  try {
    if (!isAllowedTranslyExtensionOrigin(options.callerOrigin)) {
      response = failure("CALLER_NOT_ALLOWED", "This extension is not allowed to connect to Lane.");
    } else {
      parseConnectRequest(await readNativeMessage(options.stdin ?? process.stdin));
      const result = await options.connect();
      response = result.ok
        ? {
            protocolVersion: LANE_NATIVE_PROTOCOL_VERSION,
            ok: true,
            data: result.data as LaneNativeConnection,
          }
        : failure(result.error.code, result.error.message, result.error.retryable);
    }
  } catch {
    response = failure("LANE_UNAVAILABLE", "Lane is unavailable.", true);
  }
  await new Promise<void>((resolve, reject) => {
    output.write(encodeNativeMessage(response), (error) => (error ? reject(error) : resolve()));
  });
  return response.ok ? 0 : 1;
}
