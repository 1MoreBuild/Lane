import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { AppCore } from "../src/main/app-core.ts";
import { ConfigStore, defaultConfig } from "../src/main/config-store.ts";
import { SecureCredentialStore } from "../src/main/credential-store.ts";
import { SecretStore } from "../src/main/secret-store.ts";
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
    state = await first.setDefaultImageModel(`${providerId}/mock-image`);
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
