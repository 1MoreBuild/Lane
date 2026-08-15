import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AppCore } from "../src/main/app-core.ts";
import { ConfigStore, defaultConfig } from "../src/main/config-store.ts";
import { SecureCredentialStore } from "../src/main/credential-store.ts";
import { SecretStore } from "../src/main/secret-store.ts";
import {
  TRANSLY_EXTENSION_ORIGINS,
  TRANSLY_PRODUCTION_EXTENSION_ORIGIN,
} from "../src/shared/native-messaging.ts";
import { closeServer, freePort, tempPath, TestSecretBackend } from "./helpers.ts";

async function stores() {
  const settingsPath = await tempPath("settings.json");
  const secretsPath = settingsPath.replace("settings.json", "secrets.json");
  const configStore = new ConfigStore(settingsPath);
  const secretStore = new SecretStore(secretsPath, new TestSecretBackend());
  const credentials = new SecureCredentialStore(secretStore);
  return { configStore, secretStore, credentials };
}

const discover = async () => [
  { id: "mock-model", name: "Mock model" },
  { id: "mock-image", name: "Mock image" },
];

describe("persistence and lifecycle", () => {
  it("keeps new Windows installs in the system tray by default", () => {
    expect(defaultConfig("win32").visibility).toEqual({
      showDockIcon: false,
      showMenuBarIcon: true,
    });
    expect(defaultConfig("darwin").visibility).toEqual({
      showDockIcon: true,
      showMenuBarIcon: true,
    });
  });

  it("marks only providers with missing credentials for reconnection", async () => {
    const shared = await stores();
    const app = new AppCore({ ...shared, discover });
    await app.initialize();
    let state = await app.addProvider({
      kind: "custom-openai",
      name: "Local mock",
      apiKey: "first-secret",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    const provider = state.providers[0]!;
    await shared.credentials.delete(provider.id);

    state = await app.getState();
    expect(state.credentialStorage).toEqual({ available: true });
    expect(state.providers[0]).toMatchObject({
      id: provider.id,
      connected: false,
      needsReconnection: true,
    });

    state = await app.addProvider({
      providerId: provider.id,
      kind: "custom-openai",
      apiKey: "replacement-secret",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    expect(state.providers).toHaveLength(1);
    expect(state.providers[0]).toMatchObject({
      id: provider.id,
      name: "Local mock",
      connected: true,
    });
    expect(state.providers[0]?.needsReconnection).toBeUndefined();
    await app.shutdown();
  });

  it("repairs a provider with an unreadable stored credential", async () => {
    const shared = await stores();
    const app = new AppCore({ ...shared, discover });
    await app.initialize();
    let state = await app.addProvider({
      kind: "custom-openai",
      name: "Local mock",
      apiKey: "first-secret",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    const provider = state.providers[0]!;
    await shared.secretStore.set(`credential:${provider.id}`, "not-json");

    state = await app.getState();
    expect(state.providers[0]).toMatchObject({
      id: provider.id,
      connected: false,
      needsReconnection: true,
      baseUrl: "http://127.0.0.1:9999/v1",
      error: "Invalid stored credential",
    });

    state = await app.addProvider({
      providerId: provider.id,
      kind: "custom-openai",
      apiKey: "replacement-secret",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    expect(state.providers).toHaveLength(1);
    expect(state.providers[0]).toMatchObject({
      id: provider.id,
      name: "Local mock",
      connected: true,
    });
    expect(await shared.credentials.read(provider.id)).toEqual({
      type: "api_key",
      key: "replacement-secret",
    });
    await app.shutdown();
  });

  it("opens with an ephemeral client key when secure storage is denied", async () => {
    const settingsPath = await tempPath("denied-settings.json");
    const secretsPath = settingsPath.replace("settings.json", "secrets.json");
    await writeFile(
      secretsPath,
      JSON.stringify({ "lane:client-key": Buffer.from("locked").toString("base64") }),
    );
    const backend = new TestSecretBackend();
    const secretStore = new SecretStore(secretsPath, {
      isAvailable: () => true,
      encrypt: (value) => backend.encrypt(value),
      decrypt: () => {
        throw new Error("User denied Keychain access");
      },
    });
    const app = new AppCore({
      configStore: new ConfigStore(settingsPath),
      secretStore,
      credentials: new SecureCredentialStore(secretStore),
      discover,
    });

    await expect(app.initialize()).resolves.toBeUndefined();
    const state = await app.getState();
    expect(state.clientKey).toHaveLength(43);
    expect(state.credentialStorage.available).toBe(false);
    expect(state.credentialStorage.error).toMatch(/Keychain/);
    await app.shutdown();
  });

  it("keeps raw activity capture scoped to the current app process", async () => {
    const shared = await stores();
    const first = new AppCore({ ...shared, discover });
    await first.initialize();
    expect((await first.getState()).activityCaptureEnabled).toBe(false);
    expect((await first.setActivityCapture(true)).activityCaptureEnabled).toBe(true);
    await first.shutdown();

    const second = new AppCore({ ...shared, discover });
    await second.initialize();
    expect((await second.getState()).activityCaptureEnabled).toBe(false);
    await second.shutdown();
  });

  it("migrates legacy settings to High reasoning effort", async () => {
    const settingsPath = await tempPath("legacy-settings.json");
    const legacy = defaultConfig() as Partial<ReturnType<typeof defaultConfig>>;
    delete legacy.reasoningEffort;
    await writeFile(settingsPath, JSON.stringify(legacy));

    expect((await new ConfigStore(settingsPath).load()).reasoningEffort).toBe("high");
  });

  it("uses GPT-5.6 Luna as the Codex default without overriding a saved choice", async () => {
    const firstShared = await stores();
    await firstShared.configStore.save({
      ...defaultConfig(),
      providers: [
        {
          id: "openai-codex",
          kind: "openai-codex",
          name: "ChatGPT / Codex",
          models: [],
          createdAt: 1,
        },
      ],
    });
    const first = new AppCore({ ...firstShared, discover });
    await first.initialize();
    expect((await first.getState()).defaultModel).toBe(
      "openai-codex/gpt-5.6-luna",
    );
    await first.shutdown();

    const secondShared = await stores();
    await secondShared.configStore.save({
      ...defaultConfig(),
      providers: [
        {
          id: "openai-codex",
          kind: "openai-codex",
          name: "ChatGPT / Codex",
          models: [],
          createdAt: 1,
        },
      ],
      defaultModel: "openai-codex/gpt-5.6-sol",
    });
    const second = new AppCore({ ...secondShared, discover });
    await second.initialize();
    expect((await second.getState()).defaultModel).toBe(
      "openai-codex/gpt-5.6-sol",
    );
    await second.shutdown();
  });

  it("authorizes a browser extension, starts the gateway, and persists automatic restore", async () => {
    const port = await freePort();
    const shared = await stores();
    await shared.configStore.save({
      ...defaultConfig(),
      gateway: {
        port,
        autoStart: false,
        allowedOrigins: [`http://127.0.0.1:${port}`],
      },
    });
    const core = new AppCore({ ...shared, discover });
    await core.initialize();
    await expect(
      core.connectBrowserClient("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toThrow("not allowed");
    const state = await core.connectBrowserClient(TRANSLY_PRODUCTION_EXTENSION_ORIGIN);
    expect(state.gateway.running).toBe(true);
    const stored = await shared.configStore.load();
    expect(stored.gateway.autoStart).toBe(true);
    expect(stored.gateway.allowedOrigins).toEqual(
      expect.arrayContaining([...TRANSLY_EXTENSION_ORIGINS]),
    );
    await core.shutdown();
  });

  it("removes browser-extension origins that are no longer allowlisted", async () => {
    const settingsPath = await tempPath("settings.json");
    const store = new ConfigStore(settingsPath);
    await writeFile(settingsPath, JSON.stringify({
      ...defaultConfig(),
      gateway: {
        ...defaultConfig().gateway,
        allowedOrigins: [
          "http://127.0.0.1:3210",
          "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          TRANSLY_PRODUCTION_EXTENSION_ORIGIN,
        ],
      },
    }));

    expect((await store.load()).gateway.allowedOrigins).toEqual([
      "http://127.0.0.1:3210",
      TRANSLY_PRODUCTION_EXTENSION_ORIGIN,
    ]);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).gateway.allowedOrigins).toEqual([
      "http://127.0.0.1:3210",
      TRANSLY_PRODUCTION_EXTENSION_ORIGIN,
    ]);
  });

  it("continues queued settings updates after a failed mutation", async () => {
    const settingsPath = await tempPath("settings-queue.json");
    const store = new ConfigStore(settingsPath);
    await store.save(defaultConfig());

    await expect(
      store.update(async () => {
        throw new Error("simulated settings failure");
      }),
    ).rejects.toThrow("simulated settings failure");

    const updated = await store.update((current) => ({
      ...current,
      launchAtLogin: true,
    }));
    expect(updated.launchAtLogin).toBe(true);
    expect((await store.load()).launchAtLogin).toBe(true);
  });

  it("restores providers, default model, client key, and running gateway after restart", async () => {
    const port = await freePort();
    const shared = await stores();
    await shared.configStore.save({
      ...defaultConfig(),
      gateway: {
        port,
        autoStart: false,
        allowedOrigins: [`http://127.0.0.1:${port}`],
      },
    });
    const loginValues: boolean[] = [];
    const dockValues: boolean[] = [];
    const menuBarValues: boolean[] = [];
    const first = new AppCore({
      ...shared,
      discover,
      setLaunchAtLogin: (enabled) => loginValues.push(enabled),
      setDockIconVisible: (enabled) => {
        dockValues.push(enabled);
      },
      setMenuBarIconVisible: (enabled) => {
        menuBarValues.push(enabled);
      },
    });
    await first.initialize();
    let state = await first.addProvider({
      kind: "custom-openai",
      name: "Mock",
      apiKey: "secret-value",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    const providerId = state.providers[0]!.id;
    await first.setDefaultModel(`${providerId}/mock-model`);
    await first.setDefaultImageModel(`${providerId}/mock-image`);
    await first.setReasoningEffort("max");
    state = await first.setSpeedMode("fast");
    const originalKey = state.clientKey;
    state = await first.startGateway();
    expect(state.gateway.running).toBe(true);
    await first.setLaunchOnLogin(true);
    await first.setDockIconVisible(false);
    await first.setMenuBarIconVisible(false);
    await first.setCliEnabled(true);
    await first.shutdown();

    const second = new AppCore({
      ...shared,
      discover,
      setLaunchAtLogin: (enabled) => loginValues.push(enabled),
      setDockIconVisible: (enabled) => {
        dockValues.push(enabled);
      },
      setMenuBarIconVisible: (enabled) => {
        menuBarValues.push(enabled);
      },
    });
    await second.initialize();
    state = await second.getState();
    expect(state.gateway.running).toBe(true);
    expect(state.defaultModel).toBe(`${providerId}/mock-model`);
    expect(state.defaultImageModel).toBe(`${providerId}/mock-image`);
    expect(state.reasoningEffort).toBe("max");
    expect(state.speedMode).toBe("fast");
    expect(state.clientKey).toBe(originalKey);
    expect(state.launchAtLogin).toBe(true);
    expect(state.visibility).toEqual({
      showDockIcon: false,
      showMenuBarIcon: false,
    });
    expect(state.cliEnabled).toBe(true);
    expect(loginValues.at(-1)).toBe(true);
    expect(dockValues.at(-1)).toBe(false);
    expect(menuBarValues.at(-1)).toBe(false);

    state = await second.removeProvider(providerId);
    expect(state.providers).toHaveLength(0);
    expect(state.defaultModel).toBeUndefined();
    expect(state.defaultImageModel).toBeUndefined();
    expect(await shared.credentials.read(providerId)).toBeUndefined();
    await second.shutdown();
  });

  it("retries a transient port conflict without changing the API port", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    const shared = await stores();
    await shared.configStore.save({
      ...defaultConfig(),
      gateway: {
        port,
        autoStart: false,
        allowedOrigins: [`http://127.0.0.1:${port}`],
      },
    });
    const core = new AppCore({ ...shared, discover });
    let blockerClosed = false;
    try {
      await core.initialize();
      setTimeout(() => {
        blocker.close(() => {
          blockerClosed = true;
        });
      }, 150);
      const state = await core.startGateway();
      expect(state.gateway.running).toBe(true);
      expect(state.gateway.endpoint).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await core.shutdown();
      if (!blockerClosed) await closeServer(blocker);
    }
  });

  it("moves to a confirmed alternative port and persists the new API URL", async () => {
    const originalPort = await freePort();
    const alternativePort = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(originalPort, "127.0.0.1", resolve),
    );
    const shared = await stores();
    await shared.configStore.save({
      ...defaultConfig(),
      gateway: {
        port: originalPort,
        autoStart: false,
        allowedOrigins: [
          `http://127.0.0.1:${originalPort}`,
          `http://localhost:${originalPort}`,
          TRANSLY_PRODUCTION_EXTENSION_ORIGIN,
        ],
      },
    });
    const core = new AppCore({ ...shared, discover });
    try {
      await core.initialize();
      const state = await core.startGatewayOnPort(alternativePort);
      expect(state.gateway.running).toBe(true);
      expect(state.gateway.endpoint).toBe(`http://127.0.0.1:${alternativePort}`);
      expect((await shared.configStore.load()).gateway).toEqual({
        port: alternativePort,
        autoStart: true,
        allowedOrigins: [
          `http://127.0.0.1:${alternativePort}`,
          `http://localhost:${alternativePort}`,
          TRANSLY_PRODUCTION_EXTENSION_ORIGIN,
        ],
      });
    } finally {
      await core.shutdown();
      await closeServer(blocker);
    }
  });

  it("diagnoses a port conflict during automatic restore", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    const shared = await stores();
    await shared.configStore.save({
      ...defaultConfig(),
      gateway: {
        port,
        autoStart: true,
        allowedOrigins: [`http://127.0.0.1:${port}`],
      },
    });
    const core = new AppCore({ ...shared, discover });
    try {
      await core.initialize();
      const state = await core.getState();
      expect(state.gateway.running).toBe(false);
      expect(state.gateway.error).toContain(`Port ${port} is already in use`);
      expect(state.logs.some((entry) => entry.message.includes("already in use"))).toBe(true);
    } finally {
      await core.shutdown();
      await closeServer(blocker);
    }
  });
});
