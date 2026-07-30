import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretBackend } from "../src/main/secret-store.ts";

export class TestSecretBackend implements SecretBackend {
  isAvailable(): boolean {
    return true;
  }

  encrypt(plaintext: string): Buffer {
    return Buffer.from(`encrypted:${Buffer.from(plaintext).toString("base64")}`);
  }

  decrypt(ciphertext: Buffer): string {
    const value = ciphertext.toString();
    if (!value.startsWith("encrypted:")) throw new Error("Invalid test ciphertext");
    return Buffer.from(value.slice("encrypted:".length), "base64").toString();
  }
}

export async function tempPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "lane-test-")), name);
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  const port = address.port;
  await closeServer(server);
  return port;
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
