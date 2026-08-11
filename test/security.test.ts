import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GatewayServer } from "../src/main/gateway.ts";
import { SecureCredentialStore } from "../src/main/credential-store.ts";
import { redact } from "../src/main/logger.ts";
import type { CanonicalEvent, CanonicalRequest, ModelRuntime } from "../src/main/runtime.ts";
import {
  assertSafeOAuthAuthorizationUrl,
  assertSafeUpstreamUrl,
  LOOPBACK_HOST,
} from "../src/main/security.ts";
import { SecretStore } from "../src/main/secret-store.ts";
import {
  parseKeychainCreatedAt,
  resolveSafeStorageProfile,
} from "../src/main/safe-storage-profile.ts";
import { freePort, tempPath, TestSecretBackend } from "./helpers.ts";

class EchoRuntime implements ModelRuntime {
  listModels() {
    return [{ id: "mock/model", provider: "mock", name: "Mock" }];
  }

  async *stream(_request: CanonicalRequest, _signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    yield { type: "start", model: "mock/model" };
    yield { type: "text_delta", delta: "ok" };
    yield { type: "done", reason: "stop", usage: { input: 1, output: 1, total: 2 } };
  }
}

describe("security boundaries", () => {
  it("isolates development and legacy pre-signing Keychain identities", () => {
    expect(
      parseKeychainCreatedAt(
        '"cdat"<timedate>=0x00  "20260728230859Z\\000"',
      ),
    ).toBe(Date.parse("2026-07-28T23:08:59Z"));
    expect(
      resolveSafeStorageProfile({
        releaseBuild: false,
        packaged: false,
        e2e: false,
        platform: "darwin",
        legacy: { found: true },
        newProfileExists: false,
      }),
    ).toMatchObject({
      appName: "Lane Development",
      secretsFile: "secrets-development.json",
    });
    expect(
      resolveSafeStorageProfile({
        releaseBuild: true,
        packaged: true,
        e2e: false,
        platform: "darwin",
        legacy: { found: true, createdAt: Date.parse("2026-07-28T23:08:59Z") },
        newProfileExists: false,
      }),
    ).toMatchObject({
      appName: "Lane",
      secretsFile: "secrets-v2.json",
      notice: expect.stringMatching(/Reconnect providers/),
    });
    expect(
      resolveSafeStorageProfile({
        releaseBuild: true,
        packaged: true,
        e2e: false,
        platform: "darwin",
        legacy: { found: true, createdAt: Date.parse("2026-08-10T00:00:00Z") },
        newProfileExists: false,
      }),
    ).toEqual({ secretsFile: "secrets.json" });
    expect(
      resolveSafeStorageProfile({
        releaseBuild: true,
        packaged: true,
        e2e: false,
        platform: "darwin",
        legacy: { found: true, createdAt: Date.parse("2026-07-28T23:08:59Z") },
        newProfileExists: true,
      }),
    ).toEqual({ appName: "Lane", secretsFile: "secrets-v2.json" });
  });

  it("keeps the listener host fixed to IPv4 loopback", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
    expect(() => assertSafeUpstreamUrl("http://192.168.1.20:8080/v1")).toThrow(/HTTPS/);
    expect(assertSafeUpstreamUrl("http://127.0.0.1:11434/v1").hostname).toBe("127.0.0.1");
  });

  it("requires PKCE, state, and a loopback OAuth redirect", () => {
    const valid = new URL("https://auth.openai.com/oauth/authorize");
    valid.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
    valid.searchParams.set("state", "0123456789abcdef0123456789abcdef");
    valid.searchParams.set("code_challenge", "challenge");
    valid.searchParams.set("code_challenge_method", "S256");
    expect(assertSafeOAuthAuthorizationUrl(valid.toString()).hostname).toBe("auth.openai.com");

    const bad = new URL(valid);
    bad.searchParams.set("redirect_uri", "https://evil.example/callback");
    expect(() => assertSafeOAuthAuthorizationUrl(bad.toString())).toThrow(/loopback/);
    valid.searchParams.delete("state");
    expect(() => assertSafeOAuthAuthorizationUrl(valid.toString())).toThrow(/state/);
  });

  it("rejects missing/wrong client keys and disallowed origins without wildcard CORS", async () => {
    const port = await freePort();
    const gateway = new GatewayServer(new EchoRuntime());
    await gateway.start(
      {
        port,
        autoStart: false,
        allowedOrigins: [`http://127.0.0.1:${port}`],
      },
      "correct-key",
    );
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/health`);
      expect(missing.status).toBe(401);
      const wrong = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: "Bearer wrong-key" },
      });
      expect(wrong.status).toBe(401);
      const denied = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: {
          Authorization: "Bearer correct-key",
          Origin: "https://evil.example",
        },
      });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      const allowed = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: {
          Authorization: "Bearer correct-key",
          Origin: `http://127.0.0.1:${port}`,
        },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe(
        `http://127.0.0.1:${port}`,
      );
    } finally {
      await gateway.stop();
    }
  });

  it("stores encrypted secrets and redacts logs", async () => {
    const file = await tempPath("secrets.json");
    const store = new SecretStore(file, new TestSecretBackend());
    await store.set("credential:openai", JSON.stringify({ type: "api_key", key: "sk-supersecret123" }));
    const disk = await readFile(file, "utf8");
    expect(disk).not.toContain("sk-supersecret123");
    expect(await store.get("credential:openai")).toContain("sk-supersecret123");

    expect(redact("Authorization: Bearer abcdefghijklmnop")).toContain("[REDACTED]");
    expect(redact("api_key=sk-supersecret123")).not.toContain("supersecret");
    expect(
      redact("eyJabcdefghijk.eyJabcdefghijklmnop.qwertyuiopasdfgh"),
    ).toBe("[REDACTED]");
  });

  it("preserves the post-write credential when modify returns undefined", async () => {
    const file = await tempPath("credentials.json");
    const secrets = new SecretStore(file, new TestSecretBackend());
    const credentials = new SecureCredentialStore(secrets);
    const original = {
      type: "oauth" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    };
    await credentials.modify("openai-codex", async () => original);

    const result = await credentials.modify("openai-codex", async () => undefined);

    expect(result).toEqual(original);
    expect(await credentials.read("openai-codex")).toEqual(original);
  });

  it("continues queued credential writes after a failed mutation", async () => {
    const file = await tempPath("credential-queue.json");
    const credentials = new SecureCredentialStore(
      new SecretStore(file, new TestSecretBackend()),
    );
    const failed = credentials.modify("openai", async () => {
      throw new Error("simulated refresh failure");
    });
    const recovered = credentials.modify("openai", async () => ({
      type: "api_key" as const,
      key: "recovered-key",
    }));

    await expect(failed).rejects.toThrow("simulated refresh failure");
    await expect(recovered).resolves.toEqual({
      type: "api_key",
      key: "recovered-key",
    });
    expect(await credentials.read("openai")).toEqual({
      type: "api_key",
      key: "recovered-key",
    });
  });

  it("continues secure storage writes after a backend failure", async () => {
    const file = await tempPath("secret-queue.json");
    let attempts = 0;
    const backend = new TestSecretBackend();
    const store = new SecretStore(file, {
      isAvailable: () => true,
      encrypt: (value) => {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated encryption failure");
        return backend.encrypt(value);
      },
      decrypt: (value) => backend.decrypt(value),
    });

    await expect(store.set("first", "unwritten")).rejects.toThrow(
      "simulated encryption failure",
    );
    await expect(store.set("second", "recovered")).resolves.toBeUndefined();
    expect(await store.get("second")).toBe("recovered");
  });

  it("keeps upstream credentials out of the renderer bridge", async () => {
    const preload = await readFile(
      new URL("../src/main/preload.ts", import.meta.url),
      "utf8",
    );
    const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).toContain('window.webContents.on("will-navigate"');
    expect(main).toContain('return { action: "deny" }');
    expect(preload).not.toMatch(/getCredential|readSecret|apiKey.*invoke/i);
    expect(preload).toContain('contextBridge.exposeInMainWorld("lane"');
  });
});
