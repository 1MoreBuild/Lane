import { contextBridge, ipcRenderer } from "electron";
import type {
  AddProviderInput,
  CliIntegrationState,
  GatewayConnectivityResult,
  LaneRendererApi,
  LaneState,
  LaneUpdateCheckResult,
  LaneUpdateState,
  OAuthUiEvent,
  ReasoningEffort,
  SpeedMode,
} from "../shared/contracts.ts";

const api: LaneRendererApi = {
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke("lane:get-app-version") as Promise<string>,
  getState: () => ipcRenderer.invoke("lane:get-state") as Promise<LaneState>,
  clearActivity: () =>
    ipcRenderer.invoke("lane:clear-activity") as Promise<LaneState>,
  setActivityCapture: (enabled: boolean) =>
    ipcRenderer.invoke("lane:set-activity-capture", enabled) as Promise<LaneState>,
  getUpdateState: () =>
    ipcRenderer.invoke("lane:get-update-state") as Promise<LaneUpdateState>,
  checkForUpdates: () =>
    ipcRenderer.invoke("lane:check-for-updates") as Promise<LaneUpdateCheckResult>,
  downloadUpdate: () => ipcRenderer.invoke("lane:download-update") as Promise<void>,
  addProvider: (input: AddProviderInput) =>
    ipcRenderer.invoke("lane:add-provider", input) as Promise<LaneState>,
  removeProvider: (providerId: string) =>
    ipcRenderer.invoke("lane:remove-provider", providerId) as Promise<LaneState>,
  startOAuth: () => ipcRenderer.invoke("lane:start-oauth") as Promise<LaneState>,
  submitOAuthCode: (code: string) => ipcRenderer.invoke("lane:submit-oauth-code", code),
  cancelOAuth: () => ipcRenderer.invoke("lane:cancel-oauth"),
  setDefaultModel: (modelId: string) =>
    ipcRenderer.invoke("lane:set-default-model", modelId) as Promise<LaneState>,
  setDefaultImageModel: (modelId: string) =>
    ipcRenderer.invoke("lane:set-default-image-model", modelId) as Promise<LaneState>,
  setReasoningEffort: (effort: ReasoningEffort) =>
    ipcRenderer.invoke("lane:set-reasoning-effort", effort) as Promise<LaneState>,
  setSpeedMode: (mode: SpeedMode) =>
    ipcRenderer.invoke("lane:set-speed-mode", mode) as Promise<LaneState>,
  startGateway: () => ipcRenderer.invoke("lane:start-gateway") as Promise<LaneState>,
  stopGateway: () => ipcRenderer.invoke("lane:stop-gateway") as Promise<LaneState>,
  setLaunchAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke("lane:set-launch-at-login", enabled) as Promise<LaneState>,
  setDockIconVisible: (enabled: boolean) =>
    ipcRenderer.invoke("lane:set-dock-icon-visible", enabled) as Promise<LaneState>,
  setMenuBarIconVisible: (enabled: boolean) =>
    ipcRenderer.invoke("lane:set-menu-bar-icon-visible", enabled) as Promise<LaneState>,
  getCliIntegration: () =>
    ipcRenderer.invoke("lane:get-cli-integration") as Promise<CliIntegrationState>,
  installCliIntegration: () =>
    ipcRenderer.invoke("lane:install-cli-integration") as Promise<CliIntegrationState>,
  testGatewayConnectivity: () =>
    ipcRenderer.invoke("lane:test-gateway-connectivity") as Promise<GatewayConnectivityResult>,
  copyText: (text: string) => ipcRenderer.invoke("lane:copy-text", text),
  openMainWindow: () => ipcRenderer.invoke("lane:open-main-window"),
  quitApp: () => ipcRenderer.invoke("lane:quit-app"),
  onStateChanged: (listener: (state: LaneState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: LaneState) => listener(state);
    ipcRenderer.on("lane:state-changed", handler);
    return () => ipcRenderer.removeListener("lane:state-changed", handler);
  },
  onUpdateStateChanged: (listener: (state: LaneUpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: LaneUpdateState) =>
      listener(state);
    ipcRenderer.on("lane:update-state-changed", handler);
    return () => ipcRenderer.removeListener("lane:update-state-changed", handler);
  },
  onOAuthEvent: (listener: (event: OAuthUiEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: OAuthUiEvent) => listener(value);
    ipcRenderer.on("lane:oauth-event", handler);
    return () => ipcRenderer.removeListener("lane:oauth-event", handler);
  },
  onOpenSettings: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("lane:open-settings", handler);
    return () => ipcRenderer.removeListener("lane:open-settings", handler);
  },
};

contextBridge.exposeInMainWorld("lane", Object.freeze(api));
