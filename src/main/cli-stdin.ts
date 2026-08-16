import { connect } from "node:net";
import type { Readable } from "node:stream";

const MAX_PROVIDER_KEY_BYTES = 64 * 1024;
const WINDOWS_PIPE_PATTERN = /^\\\\\.\\pipe\\lane-cli-stdin-[0-9a-f]{32}$/u;

export function validateWindowsCliStdinPipe(pipePath: string): string {
  if (!WINDOWS_PIPE_PATTERN.test(pipePath)) {
    throw new Error("Invalid Lane CLI stdin pipe");
  }
  return pipePath;
}

export async function readLimitedUtf8(
  stream: AsyncIterable<string | Buffer>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    byteLength += buffer.byteLength;
    if (byteLength > MAX_PROVIDER_KEY_BYTES) {
      throw new Error("Provider API key is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

async function readWindowsNamedPipe(pipePath: string): Promise<string> {
  const socket = connect(validateWindowsCliStdinPipe(pipePath));
  socket.setTimeout(10_000, () => {
    socket.destroy(new Error("Timed out waiting for the Lane CLI stdin pipe"));
  });
  try {
    return await readLimitedUtf8(socket);
  } finally {
    socket.destroy();
  }
}

export async function defaultReadStdin(
  stdin: Readable = process.stdin,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const pipePath = environment.LANE_CLI_STDIN_PIPE;
  if (pipePath) return readWindowsNamedPipe(pipePath);
  stdin.setEncoding("utf8");
  return readLimitedUtf8(stdin);
}
