export type ProviderKind =
  | "openai-codex"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "custom-openai";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  models: string[];
  createdAt: number;
}

export interface GatewayConfig {
  port: number;
  autoStart: boolean;
  allowedOrigins: string[];
}

export interface AppVisibilityConfig {
  showDockIcon: boolean;
  showMenuBarIcon: boolean;
}

export interface CliConfig {
  enabled: boolean;
}

export interface LaneConfig {
  version: 1;
  gateway: GatewayConfig;
  providers: ProviderConfig[];
  defaultModel?: string;
  defaultImageModel?: string;
  launchAtLogin: boolean;
  visibility: AppVisibilityConfig;
  cli: CliConfig;
}

export interface ProviderStatus {
  id: string;
  kind: ProviderKind;
  name: string;
  connected: boolean;
  authType?: "api_key" | "oauth";
  models: string[];
  error?: string;
}

export interface PublicModel {
  id: string;
  provider: string;
  name: string;
}

export interface LaneState {
  gateway: {
    running: boolean;
    endpoint: string;
    port: number;
    error?: string;
  };
  providers: ProviderStatus[];
  models: PublicModel[];
  imageModels: PublicModel[];
  defaultModel?: string;
  defaultImageModel?: string;
  launchAtLogin: boolean;
  visibility: AppVisibilityConfig;
  cliEnabled: boolean;
  clientKey: string;
  logs: LogEntry[];
}

export interface CliIntegrationState {
  enabled: boolean;
  installed: boolean;
  command: string;
  path?: string;
  error?: string;
}

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface AddProviderInput {
  kind: Exclude<ProviderKind, "openai-codex">;
  name?: string;
  apiKey: string;
  baseUrl?: string;
}

export interface LaneRendererApi {
  readonly platform: string;
  getState(): Promise<LaneState>;
  addProvider(input: AddProviderInput): Promise<LaneState>;
  removeProvider(providerId: string): Promise<LaneState>;
  startOAuth(): Promise<LaneState>;
  submitOAuthCode(code: string): Promise<void>;
  cancelOAuth(): Promise<void>;
  setDefaultModel(modelId: string): Promise<LaneState>;
  setDefaultImageModel(modelId: string): Promise<LaneState>;
  startGateway(): Promise<LaneState>;
  stopGateway(): Promise<LaneState>;
  setLaunchAtLogin(enabled: boolean): Promise<LaneState>;
  setDockIconVisible(enabled: boolean): Promise<LaneState>;
  setMenuBarIconVisible(enabled: boolean): Promise<LaneState>;
  getCliIntegration(): Promise<CliIntegrationState>;
  installCliIntegration(): Promise<CliIntegrationState>;
  copyText(text: string): Promise<void>;
  openMainWindow(): Promise<void>;
  quitApp(): Promise<void>;
  onStateChanged(listener: (state: LaneState) => void): () => void;
  onOAuthEvent(listener: (event: OAuthUiEvent) => void): () => void;
}

export type OAuthUiEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "prompt"; promptType: string; message: string }
  | { type: "progress"; message: string }
  | { type: "error"; message: string };

declare global {
  interface Window {
    lane: LaneRendererApi;
  }
}
