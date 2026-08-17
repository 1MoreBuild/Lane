import { randomBytes, randomUUID } from "node:crypto";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type {
  AddProviderInput,
  LaneConfig,
  LaneState,
  ProviderConfig,
  ProviderKind,
  ProviderStatus,
  ReasoningEffort,
  SpeedMode,
} from "../shared/contracts.ts";
import {
  isAllowedTranslyExtensionOrigin,
  TRANSLY_EXTENSION_ORIGINS,
} from "../shared/native-messaging.ts";
import { ConfigStore } from "./config-store.ts";
import {
  InvalidStoredCredentialError,
  type SecureCredentialStore,
} from "./credential-store.ts";
import { GatewayServer, GatewayStartError, RuntimeHolder } from "./gateway.ts";
import { LaneLogger, redact } from "./logger.ts";
import {
  discoverModels,
  type DiscoveryInput,
} from "./model-discovery.ts";
import { OAuthCoordinator } from "./oauth-coordinator.ts";
import { buildModels, PiAiRuntime } from "./pi-runtime.ts";
import { buildImageModels, PiAiImageRuntime } from "./image-runtime.ts";
import type { ModelRuntime } from "./runtime.ts";
import { assertSafeUpstreamUrl } from "./security.ts";
import type { SecretStore } from "./secret-store.ts";

const CLIENT_KEY_SECRET = "lane:client-key";
const PORT_RETRY_DELAYS_MS = [0, 100, 250, 500] as const;
export const DEFAULT_CODEX_MODEL = "openai-codex/gpt-5.6-luna";

const DEFAULT_NAMES: Record<Exclude<ProviderKind, "openai-codex">, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "custom-openai": "Custom OpenAI-compatible",
};

class EmptyRuntime implements ModelRuntime {
  listModels() {
    return [];
  }

  async *stream(): AsyncIterable<never> {
    throw new Error("No providers are configured");
  }
}

export interface AppCoreOptions {
  configStore: ConfigStore;
  secretStore: SecretStore;
  credentials: SecureCredentialStore;
  logger?: LaneLogger;
  discover?: (
    input: DiscoveryInput,
    fetcher?: typeof fetch,
    signal?: AbortSignal,
  ) => ReturnType<typeof discoverModels>;
  setLaunchAtLogin?: (enabled: boolean) => void;
  setDockIconVisible?: (enabled: boolean) => void | Promise<void>;
  setMenuBarIconVisible?: (enabled: boolean) => void | Promise<void>;
}

export class AppCore {
  private readonly configStore: ConfigStore;
  private readonly secretStore: SecretStore;
  private readonly credentials: SecureCredentialStore;
  private readonly logger: LaneLogger;
  private readonly discover: NonNullable<AppCoreOptions["discover"]>;
  private readonly setLoginItem: (enabled: boolean) => void;
  private readonly setDockIcon: (enabled: boolean) => void | Promise<void>;
  private readonly setMenuBarIcon: (enabled: boolean) => void | Promise<void>;
  private readonly runtime = new RuntimeHolder(new EmptyRuntime());
  readonly gateway: GatewayServer;
  private config: LaneConfig | undefined;
  private clientKey: string | undefined;
  private effectiveDefaultModel: string | undefined;
  private effectiveDefaultImageModel: string | undefined;
  private credentialStorageError: string | undefined;

  constructor(options: AppCoreOptions) {
    this.configStore = options.configStore;
    this.secretStore = options.secretStore;
    this.credentials = options.credentials;
    this.logger = options.logger ?? new LaneLogger();
    this.gateway = new GatewayServer(this.runtime, this.logger);
    this.discover = options.discover ?? discoverModels;
    this.setLoginItem = options.setLaunchAtLogin ?? (() => {});
    this.setDockIcon = options.setDockIconVisible ?? (() => {});
    this.setMenuBarIcon = options.setMenuBarIconVisible ?? (() => {});
  }

  async initialize(): Promise<void> {
    await this.logger.initialize();
    this.config = await this.configStore.load();
    try {
      this.clientKey = await this.secretStore.get(CLIENT_KEY_SECRET);
      if (!this.clientKey) {
        this.clientKey = randomBytes(32).toString("base64url");
        await this.secretStore.set(CLIENT_KEY_SECRET, this.clientKey);
      }
    } catch (error) {
      this.clientKey = randomBytes(32).toString("base64url");
      this.credentialStorageError =
        "Lane could not access macOS Keychain. Unlock the login keychain, allow Lane, then restart the app.";
      this.logger.error(`${this.credentialStorageError} ${redact(error)}`);
    }
    this.rebuildRuntime();
    if (this.config.launchAtLogin) this.setLoginItem(true);
    await this.setDockIcon(this.config.visibility.showDockIcon);
    await this.setMenuBarIcon(this.config.visibility.showMenuBarIcon);
    if (this.config.gateway.autoStart) {
      try {
        await this.startGatewayWithRetry(this.config, this.clientKey);
        this.logger.info(`Gateway restored on ${this.gateway.getEndpoint(this.config.gateway.port)}`);
      } catch (error) {
        this.logger.error(error);
      }
    }
  }

  private requireInitialized(): { config: LaneConfig; clientKey: string } {
    if (!this.config || !this.clientKey) throw new Error("Lane is not initialized");
    return { config: this.config, clientKey: this.clientKey };
  }

  private rebuildRuntime(): void {
    if (!this.config) return;
    if (this.credentialStorageError) {
      this.effectiveDefaultModel = undefined;
      this.effectiveDefaultImageModel = undefined;
      this.runtime.set(new EmptyRuntime());
      return;
    }
    const models = buildModels(this.config.providers, this.credentials as CredentialStore);
    this.effectiveDefaultModel =
      this.config.defaultModel ??
      (models.getModel("openai-codex", "gpt-5.6-luna") ? DEFAULT_CODEX_MODEL : undefined);
    const imageModels = buildImageModels(
      this.config.providers,
      this.credentials as CredentialStore,
    );
    const images = new PiAiImageRuntime(
      imageModels,
      this.config.providers,
      this.config.defaultImageModel,
    );
    this.effectiveDefaultImageModel =
      this.config.defaultImageModel ?? images.listModels()[0]?.id;
    const effectiveImages = new PiAiImageRuntime(
      imageModels,
      this.config.providers,
      this.effectiveDefaultImageModel,
    );
    this.runtime.set(
      new PiAiRuntime(
        models,
        this.config.providers,
        this.effectiveDefaultModel,
        effectiveImages,
        this.config.reasoningEffort,
        this.config.speedMode,
      ),
    );
  }

  private async persist(config: LaneConfig): Promise<void> {
    await this.configStore.save(config);
    this.config = config;
    this.rebuildRuntime();
  }

  private async startGatewayWithRetry(config: LaneConfig, clientKey: string): Promise<void> {
    let lastError: unknown;
    for (const delay of PORT_RETRY_DELAYS_MS) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        await this.gateway.start(config.gateway, clientKey);
        return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof GatewayStartError) || error.code !== "EADDRINUSE") {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private providerId(input: AddProviderInput): string {
    return input.kind === "custom-openai" ? `custom-${randomUUID()}` : input.kind;
  }

  async addProvider(input: AddProviderInput): Promise<LaneState> {
    const { config } = this.requireInitialized();
    if (!["openai", "anthropic", "openrouter", "custom-openai"].includes(input.kind)) {
      throw new Error("Unsupported provider type");
    }
    const existing = input.providerId
      ? config.providers.find((provider) => provider.id === input.providerId)
      : undefined;
    if (input.providerId && (!existing || existing.kind !== input.kind)) {
      throw new Error("Provider to reconnect was not found");
    }
    const baseUrl =
      input.kind === "custom-openai"
        ? assertSafeUpstreamUrl(input.baseUrl ?? existing?.baseUrl ?? "")
            .toString()
            .replace(/\/$/, "")
        : undefined;
    const discovered = await this.discover({
      kind: input.kind,
      apiKey: input.apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    });
    const id = existing?.id ?? this.providerId(input);
    const previousCredentialSnapshot = await this.credentials.snapshot(id);
    try {
      await this.credentials.read(id);
    } catch (error) {
      if (error instanceof InvalidStoredCredentialError || existing) {
        // Explicit reconnection may replace an unreadable credential. The
        // opaque encrypted snapshot is restored if any later step fails.
      } else {
        throw error;
      }
    }
    await this.credentials.replace(id, { type: "api_key", key: input.apiKey });
    const provider: ProviderConfig = {
      id,
      kind: input.kind,
      name: input.name?.trim() || existing?.name || DEFAULT_NAMES[input.kind],
      ...(baseUrl ? { baseUrl } : {}),
      models: discovered.map((model) => model.id),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    const providers =
      input.kind === "custom-openai" && !existing
        ? [...config.providers, provider]
        : [...config.providers.filter((item) => item.id !== id), provider];
    const providerModelPrefix = `${id}/`;
    // Re-adding a kind that is already connected replaces its entry without
    // being a reconnect, so a default naming a model the new key cannot serve
    // has to be dropped in that case too.
    const keepDefault = (modelId: string | undefined): string | undefined => {
      if (!modelId?.startsWith(providerModelPrefix)) return modelId;
      return provider.models.includes(modelId.slice(providerModelPrefix.length))
        ? modelId
        : undefined;
    };
    const defaultModel = keepDefault(config.defaultModel);
    const defaultImageModel = keepDefault(config.defaultImageModel);
    const {
      defaultModel: _previousDefaultModel,
      defaultImageModel: _previousDefaultImageModel,
      ...configWithoutDefaults
    } = config;
    try {
      await this.persist({
        ...configWithoutDefaults,
        providers,
        ...(defaultModel ? { defaultModel } : {}),
        ...(defaultImageModel ? { defaultImageModel } : {}),
      });
    } catch (error) {
      await this.credentials.restore(id, previousCredentialSnapshot);
      throw error;
    }
    this.logger.info(`Connected ${provider.name}; ${provider.models.length} models loaded`);
    return await this.getState();
  }

  async startOAuth(coordinator: Pick<OAuthCoordinator, "login">): Promise<LaneState> {
    const { config } = this.requireInitialized();
    const provisional: ProviderConfig = {
      id: "openai-codex",
      kind: "openai-codex",
      name: "ChatGPT / Codex",
      models: [],
      createdAt: Date.now(),
    };
    const models = buildModels(
      [...config.providers.filter((item) => item.id !== provisional.id), provisional],
      this.credentials,
    );
    const existing = config.providers.find(
      (provider) => provider.id === provisional.id,
    );
    const previousCredentialSnapshot = await this.credentials.snapshot(
      provisional.id,
    );
    try {
      await this.credentials.read(provisional.id);
    } catch (error) {
      // A corrupt credential must not make the provider impossible to repair.
      if (error instanceof InvalidStoredCredentialError || existing) {
        await this.credentials.delete(provisional.id);
      } else {
        throw error;
      }
    }
    try {
      await coordinator.login(models);
      const providers = [
        ...config.providers.filter((item) => item.id !== provisional.id),
        provisional,
      ];
      await this.persist({ ...config, providers });
    } catch (error) {
      await this.credentials.restore(
        provisional.id,
        previousCredentialSnapshot,
      );
      throw error;
    }
    this.logger.info("Connected ChatGPT / Codex with OAuth");
    return await this.getState();
  }

  async removeProvider(providerId: string): Promise<LaneState> {
    const { config } = this.requireInitialized();
    if (!config.providers.some((provider) => provider.id === providerId)) {
      throw new Error("Provider not found");
    }
    // An opaque snapshot, so a provider whose credential no longer decrypts
    // can still be removed and still be rolled back if persisting fails.
    const previousCredentialSnapshot = await this.credentials.snapshot(providerId);
    await this.credentials.delete(providerId);
    const defaultModel = config.defaultModel?.startsWith(`${providerId}/`)
      ? undefined
      : config.defaultModel;
    const defaultImageModel = config.defaultImageModel?.startsWith(`${providerId}/`)
      ? undefined
      : config.defaultImageModel;
    const {
      defaultModel: _previousDefaultModel,
      defaultImageModel: _previousDefaultImageModel,
      ...configWithoutDefault
    } = config;
    try {
      await this.persist({
        ...configWithoutDefault,
        providers: config.providers.filter((provider) => provider.id !== providerId),
        ...(defaultModel ? { defaultModel } : {}),
        ...(defaultImageModel ? { defaultImageModel } : {}),
      });
    } catch (error) {
      await this.credentials.restore(providerId, previousCredentialSnapshot);
      throw error;
    }
    this.logger.info(`Removed provider ${providerId} and cleared its credential`);
    return await this.getState();
  }

  async setDefaultModel(modelId: string): Promise<LaneState> {
    const { config } = this.requireInitialized();
    const models = await this.runtime.listModels();
    if (!models.some((model) => model.id === modelId)) throw new Error("Model not found");
    await this.persist({ ...config, defaultModel: modelId });
    this.logger.info(`Default model set to ${modelId}`);
    return await this.getState();
  }

  async setDefaultImageModel(modelId: string): Promise<LaneState> {
    const { config } = this.requireInitialized();
    const models = await this.runtime.listImageModels?.();
    if (!models?.some((model) => model.id === modelId)) {
      throw new Error("Image model not found");
    }
    await this.persist({ ...config, defaultImageModel: modelId });
    this.logger.info(`Default image model set to ${modelId}`);
    return await this.getState();
  }

  async setSpeedMode(mode: SpeedMode): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.persist({ ...config, speedMode: mode });
    this.logger.info(`Speed set to ${mode}`);
    return await this.getState();
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.persist({ ...config, reasoningEffort: effort });
    this.logger.info(`Reasoning effort set to ${effort}`);
    return await this.getState();
  }

  async startGateway(): Promise<LaneState> {
    const { config, clientKey } = this.requireInitialized();
    await this.startGatewayWithRetry(config, clientKey);
    try {
      await this.persist({
        ...config,
        gateway: { ...config.gateway, autoStart: true },
      });
    } catch (error) {
      await this.gateway.stop();
      throw error;
    }
    this.logger.info(`Gateway started on ${this.gateway.getEndpoint(config.gateway.port)}`);
    return await this.getState();
  }

  async startGatewayOnPort(port: number): Promise<LaneState> {
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
      throw new Error("Gateway port must be between 1024 and 65535");
    }
    if (this.gateway.isRunning()) {
      throw new Error("Stop the gateway before changing its port");
    }
    const { config, clientKey } = this.requireInitialized();
    const previousPort = config.gateway.port;
    const allowedOrigins = [...new Set(config.gateway.allowedOrigins.map((origin) => {
      if (origin === `http://127.0.0.1:${previousPort}`) {
        return `http://127.0.0.1:${port}`;
      }
      if (origin === `http://localhost:${previousPort}`) {
        return `http://localhost:${port}`;
      }
      return origin;
    }))];
    const nextConfig: LaneConfig = {
      ...config,
      gateway: {
        ...config.gateway,
        port,
        autoStart: false,
        allowedOrigins,
      },
    };
    await this.startGatewayWithRetry(nextConfig, clientKey);
    try {
      await this.persist({
        ...nextConfig,
        gateway: { ...nextConfig.gateway, autoStart: true },
      });
    } catch (error) {
      await this.gateway.stop();
      throw error;
    }
    this.logger.info(`Gateway moved to ${this.gateway.getEndpoint(port)}`);
    return await this.getState();
  }

  async connectBrowserClient(origin: string): Promise<LaneState> {
    if (!isAllowedTranslyExtensionOrigin(origin)) {
      throw new Error("Browser extension is not allowed");
    }
    const canonicalOrigin = TRANSLY_EXTENSION_ORIGINS.find(
      (allowedOrigin) => allowedOrigin === origin || `${allowedOrigin}/` === origin,
    )!;
    const { config, clientKey } = this.requireInitialized();
    const alreadyAllowed = config.gateway.allowedOrigins.includes(canonicalOrigin);
    const allowedOrigins = alreadyAllowed
      ? config.gateway.allowedOrigins
      : [...config.gateway.allowedOrigins, canonicalOrigin];
    let nextConfig = config;
    if (!alreadyAllowed) {
      nextConfig = {
        ...config,
        gateway: { ...config.gateway, allowedOrigins },
      };
      await this.persist(nextConfig);
    }
    this.gateway.setAllowedOrigins(allowedOrigins);
    if (!this.gateway.isRunning()) {
      await this.startGatewayWithRetry(nextConfig, clientKey);
      nextConfig = {
        ...nextConfig,
        gateway: { ...nextConfig.gateway, autoStart: true },
      };
      await this.persist(nextConfig);
      this.logger.info("Gateway started for an approved browser extension");
    }
    return await this.getState();
  }

  async stopGateway(): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.gateway.stop();
    await this.persist({
      ...config,
      gateway: { ...config.gateway, autoStart: false },
    });
    this.logger.info("Gateway stopped");
    return await this.getState();
  }

  async setLaunchOnLogin(enabled: boolean): Promise<LaneState> {
    const { config } = this.requireInitialized();
    this.setLoginItem(enabled);
    try {
      await this.persist({ ...config, launchAtLogin: enabled });
    } catch (error) {
      this.setLoginItem(config.launchAtLogin);
      throw error;
    }
    this.logger.info(`Launch at login ${enabled ? "enabled" : "disabled"}`);
    return await this.getState();
  }

  async setDockIconVisible(enabled: boolean): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.setDockIcon(enabled);
    try {
      await this.persist({
        ...config,
        visibility: { ...config.visibility, showDockIcon: enabled },
      });
    } catch (error) {
      await this.setDockIcon(config.visibility.showDockIcon);
      throw error;
    }
    this.logger.info(`Dock icon ${enabled ? "shown" : "hidden"}`);
    return await this.getState();
  }

  async setMenuBarIconVisible(enabled: boolean): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.setMenuBarIcon(enabled);
    try {
      await this.persist({
        ...config,
        visibility: { ...config.visibility, showMenuBarIcon: enabled },
      });
    } catch (error) {
      await this.setMenuBarIcon(config.visibility.showMenuBarIcon);
      throw error;
    }
    this.logger.info(`Menu bar icon ${enabled ? "shown" : "hidden"}`);
    return await this.getState();
  }

  async setCliEnabled(enabled: boolean): Promise<LaneState> {
    const { config } = this.requireInitialized();
    await this.persist({
      ...config,
      cli: { enabled },
    });
    this.logger.info(`CLI integration ${enabled ? "enabled" : "disabled"}`);
    return await this.getState();
  }

  private async providerStatuses(config: LaneConfig): Promise<ProviderStatus[]> {
    if (this.credentialStorageError) {
      const error = this.credentialStorageError;
      return config.providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        connected: false,
        models: [...provider.models],
        error,
      }));
    }
    return await Promise.all(
      config.providers.map(async (provider) => {
        try {
          const credential = await this.credentials.read(provider.id);
          return {
            id: provider.id,
            kind: provider.kind,
            name: provider.name,
            connected: credential !== undefined,
            ...(!credential ? { needsReconnection: true } : {}),
            ...(credential ? { authType: credential.type } : {}),
            ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
            models: [...provider.models],
          };
        } catch (error) {
          return {
            id: provider.id,
            kind: provider.kind,
            name: provider.name,
            connected: false,
            needsReconnection: true,
            ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
            models: [...provider.models],
            error: redact(error),
          };
        }
      }),
    );
  }

  async getState(): Promise<LaneState> {
    const { config, clientKey } = this.requireInitialized();
    return {
      gateway: {
        running: this.gateway.isRunning(),
        endpoint: this.gateway.getEndpoint(config.gateway.port),
        port: config.gateway.port,
        ...(this.gateway.lastError ? { error: this.gateway.lastError } : {}),
      },
      credentialStorage: {
        available: this.credentialStorageError === undefined,
        ...(this.credentialStorageError
          ? { error: this.credentialStorageError }
          : {}),
      },
      providers: await this.providerStatuses(config),
      models: await this.runtime.listModels(),
      imageModels: (await this.runtime.listImageModels?.()) ?? [],
      ...(this.effectiveDefaultModel ? { defaultModel: this.effectiveDefaultModel } : {}),
      ...(this.effectiveDefaultImageModel
        ? { defaultImageModel: this.effectiveDefaultImageModel }
        : {}),
      reasoningEffort: config.reasoningEffort,
      speedMode: config.speedMode,
      launchAtLogin: config.launchAtLogin,
      visibility: { ...config.visibility },
      cliEnabled: config.cli.enabled,
      activityCaptureEnabled: this.gateway.isCaptureEnabled(),
      clientKey,
      logs: this.logger.listActivity(),
    };
  }

  async clearActivity(): Promise<LaneState> {
    this.requireInitialized();
    await this.logger.clearActivity();
    return await this.getState();
  }

  async setActivityCapture(enabled: boolean): Promise<LaneState> {
    this.requireInitialized();
    this.gateway.setCaptureEnabled(enabled);
    return await this.getState();
  }

  async shutdown(): Promise<void> {
    await this.gateway.stop();
    await this.logger.flush();
  }
}
