import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, useTheme } from "next-themes";
import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg";
import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import openRouterIcon from "@lobehub/icons-static-svg/icons/openrouter.svg";
import {
  Activity,
  Check,
  ChevronDown,
  Clipboard,
  Download,
  Eye,
  EyeOff,
  LoaderCircle,
  Plus,
  Settings2,
  Trash2,
  Waypoints,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getLaneApiBaseUrl,
} from "../shared/api-endpoints.ts";
import type {
  AddProviderInput,
  CliIntegrationState,
  GatewayCapture,
  GatewayTrace,
  LaneState,
  LaneUpdateCheckResult,
  LaneUpdateState,
  LogEntry,
  ProviderKind,
  ProviderStatus,
  ReasoningEffort,
} from "../shared/contracts.ts";
import "./style.css";
import { ApiEndpointsDialog } from "./api-endpoints-dialog.tsx";

const CodeViewer = lazy(async () => {
  const module = await import("@/components/ui/code-viewer");
  return { default: module.CodeViewer };
});

const PROVIDER_OPTIONS = [
  {
    value: "openai-codex",
    label: "ChatGPT / Codex",
    description: "Browser OAuth",
  },
  { value: "openai", label: "OpenAI", description: "API key" },
  { value: "anthropic", label: "Anthropic", description: "API key" },
  { value: "openrouter", label: "OpenRouter", description: "API key" },
  {
    value: "custom-openai",
    label: "Custom endpoint",
    description: "OpenAI-compatible",
  },
] as const satisfies ReadonlyArray<{
  value: ProviderKind;
  label: string;
  description: string;
}>;

const REASONING_EFFORT_OPTIONS = [
  { value: "max", label: "Ultra" },
  { value: "xhigh", label: "Extra High" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Light" },
] as const satisfies ReadonlyArray<{
  value: ReasoningEffort;
  label: string;
}>;

function modelCapabilityScore(id: string): number | undefined {
  const version = id.match(/gpt-(\d+)\.(\d+)/i);
  if (!version) return undefined;

  const major = Number(version[1]);
  const minor = Number(version[2]);
  const variant = id.toLowerCase();
  const tier = variant.includes("pro")
    ? 50
    : variant.includes("sol")
      ? 40
      : variant.includes("terra")
        ? 30
        : variant.includes("luna")
          ? 10
          : variant.includes("mini")
            ? -10
            : variant.includes("nano")
              ? -20
              : variant.includes("spark")
                ? -30
                : 20;

  return major * 10_000 + minor * 100 + tier;
}

function compareModelsByCapability(
  left: LaneState["models"][number],
  right: LaneState["models"][number],
): number {
  const leftScore = modelCapabilityScore(left.id);
  const rightScore = modelCapabilityScore(right.id);
  if (leftScore !== undefined && rightScore !== undefined && leftScore !== rightScore) {
    return rightScore - leftScore;
  }
  if (leftScore !== undefined && rightScore === undefined) return -1;
  if (leftScore === undefined && rightScore !== undefined) return 1;
  return left.name.localeCompare(right.name);
}

function reasoningEffortLabel(value: ReasoningEffort): string {
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.label ?? "High";
}

function effectiveReasoningEffort(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  if (supported.includes(requested)) return requested;
  const order = REASONING_EFFORT_OPTIONS.map((option) => option.value).toReversed();
  const requestedIndex = order.indexOf(requested);
  for (let index = requestedIndex; index < order.length; index += 1) {
    const candidate = order[index];
    if (candidate && supported.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = order[index];
    if (candidate && supported.includes(candidate)) return candidate;
  }
  return requested;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ActivityItem {
  key: string;
  timestamp: number;
  level: LogEntry["level"];
  message: string;
  trace?: GatewayTrace;
  capture?: GatewayCapture;
}

function activityItems(logs: readonly LogEntry[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const requestIndexes = new Map<string, number>();
  for (const entry of logs) {
    if (!entry.trace) continue;
    const existingIndex = requestIndexes.get(entry.trace.requestId);
    if (existingIndex === undefined) {
      requestIndexes.set(entry.trace.requestId, items.length);
      items.push({
        key: entry.trace.requestId,
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        trace: { ...entry.trace },
        ...(entry.capture ? { capture: entry.capture } : {}),
      });
      continue;
    }
    const existing = items[existingIndex];
    if (!existing?.trace) continue;
    items[existingIndex] = {
      ...existing,
      level: entry.level,
      message: entry.message,
      trace: { ...existing.trace, ...entry.trace },
      ...(entry.capture ? { capture: entry.capture } : {}),
    };
  }
  return items.toReversed();
}

function shortModelName(model: string): string {
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(separator + 1) : model;
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value / 1_000)}k`;
}

function traceDetails(trace: GatewayTrace): string[] {
  const details: string[] = [];
  if (trace.provider) details.push(trace.provider);
  if (trace.model) details.push(shortModelName(trace.model));
  if (trace.stream) details.push("stream");
  if (trace.errorCode) details.push(trace.errorCode.replaceAll("_", " "));
  if (trace.durationMs !== undefined) {
    details.push(trace.durationMs < 1_000 ? `${trace.durationMs} ms` : `${(trace.durationMs / 1_000).toFixed(1)} s`);
  }
  if (trace.inputTokens !== undefined || trace.outputTokens !== undefined) {
    const input = formatCount(trace.inputTokens ?? 0);
    const output = formatCount(trace.outputTokens ?? 0);
    details.push(`${input} in · ${output} out`);
  } else if (trace.imageCount !== undefined) {
    details.push(`${trace.imageCount} ${trace.imageCount === 1 ? "image" : "images"}`);
  }
  return details;
}

function CaptureDetails({ capture }: { capture: GatewayCapture }): ReactNode {
  const initialTab = capture.request ? "request" : "response";
  return (
    <Tabs defaultValue={initialTab}>
      <TabsList aria-label="Captured HTTP bodies">
        {capture.request && <TabsTrigger value="request">Request</TabsTrigger>}
        {capture.response && <TabsTrigger value="response">Response</TabsTrigger>}
      </TabsList>
      {capture.request && (
        <TabsContent value="request">
          <Suspense fallback={<div className="h-20 rounded-lg bg-muted/50" />}>
            <CodeViewer capture={capture.request} />
          </Suspense>
        </TabsContent>
      )}
      {capture.response && (
        <TabsContent value="response">
          <Suspense fallback={<div className="h-20 rounded-lg bg-muted/50" />}>
            <CodeViewer capture={capture.response} />
          </Suspense>
        </TabsContent>
      )}
    </Tabs>
  );
}

function FieldLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="lane-label mb-1.5 block text-muted-foreground">
      {children}
    </span>
  );
}

function IconAction({
  label,
  children,
  onClick,
  destructive = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  destructive?: boolean;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        onClick={onClick}
        render={
          <Button
            className={cn(
              "[&_svg]:size-3.5 [&_svg]:stroke-[1.8]",
              destructive &&
                "text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive",
            )}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const PROVIDER_ICONS: Partial<Record<ProviderKind, string>> = {
  "openai-codex": openAiIcon,
  openai: openAiIcon,
  anthropic: anthropicIcon,
  openrouter: openRouterIcon,
};

function ProviderIcon({
  provider,
  size = "default",
}: {
  provider: Pick<ProviderStatus, "kind">;
  size?: "sm" | "default";
}): ReactNode {
  const icon = PROVIDER_ICONS[provider.kind];
  const label: Record<ProviderKind, string> = {
    "openai-codex": "Codex",
    openai: "OpenAI",
    anthropic: "Anthropic",
    openrouter: "OpenRouter",
    "custom-openai": "Custom endpoint",
  };

  return (
    <div
      aria-label={label[provider.kind]}
      className={cn(
        "flex shrink-0 items-center justify-center bg-muted text-foreground",
        size === "sm" ? "size-6.5 rounded-lg" : "size-8 rounded-[10px]",
      )}
      role="img"
    >
      {icon ? (
        <img
          alt=""
          className={cn("dark:invert", size === "sm" ? "size-3.5" : "size-[18px]")}
          src={icon}
        />
      ) : (
        <Waypoints
          className={cn(
            "stroke-[1.8]",
            size === "sm" ? "size-3.5" : "size-[18px]",
          )}
        />
      )}
    </div>
  );
}

function providerGroupLabel(provider?: ProviderStatus): string {
  if (!provider) return "Models";
  switch (provider.kind) {
    case "openai-codex":
      return "Codex";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "openrouter":
      return "OpenRouter";
    case "custom-openai":
      return provider.name;
  }
}

function ThemeSetting(): ReactNode {
  const { theme, setTheme } = useTheme();
  return (
    <Select
      value={theme ?? "system"}
      onValueChange={(value) => {
        if (value) setTheme(value);
      }}
    >
      <SelectTrigger aria-label="Theme" className="h-8 w-28">
        {theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"}
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        <SelectItem value="system">System</SelectItem>
        <SelectItem value="light">Light</SelectItem>
        <SelectItem value="dark">Dark</SelectItem>
      </SelectContent>
    </Select>
  );
}

type AppView = "activity" | "overview";

function UpdateControl({
  state,
  onClick,
}: {
  state: LaneUpdateState;
  onClick: () => void;
}): ReactNode {
  if (state.status === "idle") return null;
  const downloading = state.status === "downloading";
  const percent = downloading ? Math.round(state.percent) : undefined;
  const label = downloading
    ? `Downloading Lane ${state.version}: ${percent}%`
    : `Download Lane ${state.version}`;
  return (
    <Tooltip>
      <TooltipTrigger
        aria-disabled={downloading}
        aria-label={label}
        onClick={downloading ? undefined : onClick}
        render={
          <Button
            className="tabular-nums"
            size="icon-sm"
            title={label}
            variant="secondary"
          />
        }
      >
        {downloading ? (
          <span className="text-[0.625rem] font-semibold tracking-[-0.02em]">
            {percent}%
          </span>
        ) : (
          <Download />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function UtilityControls({
  activityOpen,
  onActivityToggle,
  onUpdateClick,
  onSettingsOpenChange,
  settingsOpen,
  settingsContent,
  updateState,
}: {
  activityOpen: boolean;
  onActivityToggle: () => void;
  onUpdateClick: () => void;
  onSettingsOpenChange: (open: boolean) => void;
  settingsOpen: boolean;
  settingsContent: ReactNode;
  updateState: LaneUpdateState;
}): ReactNode {
  return (
    <>
      {updateState.status !== "idle" && (
        <div aria-live="polite" className="flex">
          <UpdateControl onClick={onUpdateClick} state={updateState} />
        </div>
      )}
      <Button
        aria-label={activityOpen ? "Show Overview" : "Open Activity"}
        aria-pressed={activityOpen}
        id="lane-activity-trigger"
        onClick={onActivityToggle}
        size="icon-sm"
        title={activityOpen ? "Overview" : "Activity"}
        variant={activityOpen ? "secondary" : "ghost"}
      >
        <Activity />
      </Button>
      <Popover onOpenChange={onSettingsOpenChange} open={settingsOpen}>
        <PopoverTrigger
          aria-label="Open Settings"
          id="lane-settings-trigger"
          render={<Button size="icon-sm" title="Settings" variant="ghost" />}
        >
          <Settings2 />
        </PopoverTrigger>
        <PopoverContent className="w-[23rem] max-w-[calc(100vw-1.5rem)]">
          {settingsContent}
        </PopoverContent>
      </Popover>
    </>
  );
}

function App(): ReactNode {
  const [state, setState] = useState<LaneState | null>(null);
  const [updateState, setUpdateState] = useState<LaneUpdateState>({
    status: "idle",
  });
  const [appVersion, setAppVersion] = useState("");
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] =
    useState<LaneUpdateCheckResult | null>(null);
  const [loadError, setLoadError] = useState("");
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const [activityClearing, setActivityClearing] = useState(false);
  const [activityCaptureBusy, setActivityCaptureBusy] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [reconnectTarget, setReconnectTarget] = useState<ProviderStatus | null>(null);
  const [providerKind, setProviderKind] = useState<ProviderKind>("openai-codex");
  const [providerName, setProviderName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [oauthStatus, setOAuthStatus] = useState("");
  const [oauthPrompt, setOAuthPrompt] = useState("");
  const [oauthCode, setOAuthCode] = useState("");
  const [removeTarget, setRemoveTarget] = useState<ProviderStatus | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [cliIntegration, setCliIntegration] = useState<CliIntegrationState | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [cliError, setCliError] = useState("");

  useEffect(() => {
    const unsubscribeState = window.lane.onStateChanged(setState);
    const unsubscribeUpdate = window.lane.onUpdateStateChanged((next) => {
      setUpdateState(next);
      if (next.status === "available") {
        setUpdateCheckResult({ status: "available", version: next.version });
      }
    });
    const unsubscribeOAuth = window.lane.onOAuthEvent((event) => {
      if (event.type === "auth_url") {
        setOAuthStatus(event.instructions ?? "Finish signing in in your browser.");
      } else if (event.type === "prompt") {
        setOAuthStatus(event.message);
        setOAuthPrompt(event.promptType);
      } else {
        setOAuthStatus(event.message);
      }
    });
    const unsubscribeOpenSettings = window.lane.onOpenSettings(() => {
      setSettingsOpen(true);
    });

    window.lane.getState().then(setState).catch((error: unknown) => {
      setLoadError(getErrorMessage(error));
    });
    window.lane.getAppVersion().then(setAppVersion).catch(() => {
      setAppVersion("Unknown");
    });
    window.lane.getUpdateState().then(setUpdateState).catch(() => {
      setUpdateState({ status: "idle" });
    });
    window.lane
      .getCliIntegration()
      .then((integration) => {
        setCliIntegration(integration);
        setCliError(integration.error ?? "");
      })
      .catch((error: unknown) => {
        setCliIntegration(null);
        setCliError(getErrorMessage(error));
      });

    return () => {
      unsubscribeState();
      unsubscribeUpdate();
      unsubscribeOAuth();
      unsubscribeOpenSettings();
    };
  }, []);

  const selectedProvider = useMemo(
    () =>
      PROVIDER_OPTIONS.find((option) => option.value === providerKind) ??
      PROVIDER_OPTIONS[0],
    [providerKind],
  );

  if (!state) {
    return (
      <main className="lane-body grid min-h-screen place-content-center gap-3 text-center text-muted-foreground">
        <LoaderCircle className="mx-auto size-4 animate-spin stroke-[1.8]" />
        <p>{loadError || "Opening Lane…"}</p>
      </main>
    );
  }

  const oauthConnected = state.providers.some(
    (provider) => provider.kind === "openai-codex" && provider.connected,
  );
  const apiBaseUrl = getLaneApiBaseUrl(state.gateway.endpoint);
  const selectedModel = state.models.find((model) => model.id === state.defaultModel);
  const selectedModelProvider = state.providers.find(
    (provider) => provider.id === selectedModel?.provider,
  );
  const supportsSpeedMode =
    selectedModelProvider?.kind === "openai" ||
    selectedModelProvider?.kind === "openai-codex";
  const supportedReasoningEfforts = selectedModel?.reasoningEfforts ?? [];
  const supportsReasoningEffort = supportedReasoningEfforts.length > 0;
  const displayedReasoningEffort = effectiveReasoningEffort(
    state.reasoningEffort,
    supportedReasoningEfforts,
  );
  const selectedImageModel = state.imageModels.find(
    (model) => model.id === state.defaultImageModel,
  );
  const selectedImageProvider = state.providers.find(
    (provider) => provider.id === selectedImageModel?.provider,
  );
  const selectedImageIsGptImage2 =
    selectedImageModel?.id.split("/").at(-1)?.startsWith("gpt-image-2") === true;
  const modelGroups = [...new Set(state.models.map((model) => model.provider))].map(
    (providerId) => ({
      id: providerId,
      name: providerGroupLabel(
        state.providers.find((provider) => provider.id === providerId),
      ),
      models: state.models
        .filter((model) => model.provider === providerId)
        .sort(compareModelsByCapability),
    }),
  );
  const imageModelGroups = [
    ...new Set(state.imageModels.map((model) => model.provider)),
  ].map((providerId) => ({
    id: providerId,
    name: providerGroupLabel(
      state.providers.find((provider) => provider.id === providerId),
    ),
    models: state.imageModels.filter((model) => model.provider === providerId),
  }));

  async function copyValue(value: string, target: string): Promise<void> {
    await window.lane.copyText(value);
    setCopied(target);
    // Without cancelling, a second copy inherits the first one's countdown and
    // its confirmation disappears early.
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = undefined;
      setCopied(null);
    }, 1400);
  }

  async function toggleGateway(checked: boolean): Promise<void> {
    setGatewayBusy(true);
    setLoadError("");
    try {
      setState(checked ? await window.lane.startGateway() : await window.lane.stopGateway());
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setGatewayBusy(false);
    }
  }

  async function updateSetting(
    action: () => Promise<LaneState>,
  ): Promise<void> {
    setSettingsBusy(true);
    setLoadError("");
    try {
      setState(await action());
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function installCliIntegration(): Promise<void> {
    setCliBusy(true);
    setCliError("");
    try {
      const integration = await window.lane.installCliIntegration();
      setCliIntegration(integration);
      setCliError(integration.error ?? "");
    } catch (error) {
      setCliError(getErrorMessage(error));
    } finally {
      setCliBusy(false);
    }
  }

  async function checkForUpdates(): Promise<void> {
    setUpdateChecking(true);
    try {
      setUpdateCheckResult(await window.lane.checkForUpdates());
    } catch {
      setUpdateCheckResult({ status: "error" });
    } finally {
      setUpdateChecking(false);
    }
  }

  const updateSummary = (() => {
    if (updateState.status === "available") {
      return `Version ${appVersion || "…"} · ${updateState.version} available`;
    }
    if (updateState.status === "downloading") {
      return `Downloading ${updateState.version} · ${Math.round(updateState.percent)}%`;
    }
    if (updateChecking) return `Version ${appVersion || "…"} · Checking…`;
    if (updateCheckResult?.status === "up-to-date") {
      return `Version ${appVersion || "…"} · Up to date`;
    }
    if (updateCheckResult?.status === "error") {
      return `Version ${appVersion || "…"} · Couldn’t check for updates`;
    }
    if (updateCheckResult?.status === "unavailable") {
      return `Version ${appVersion || "…"} · Updates unavailable in this build`;
    }
    if (updateCheckResult?.status === "busy") {
      return `Version ${appVersion || "…"} · Update check already in progress`;
    }
    return `Version ${appVersion || "…"}`;
  })();

  const updateActionLabel =
    updateState.status === "available"
      ? `Download ${updateState.version}`
      : updateState.status === "downloading"
        ? "Downloading…"
        : updateChecking
          ? "Checking…"
          : "Check for updates";

  function resetProviderForm(): void {
    setProviderName("");
    setApiKey("");
    setBaseUrl("");
    setProviderError("");
    setOAuthStatus("");
    setOAuthPrompt("");
    setOAuthCode("");
  }

  function openAddProvider(): void {
    resetProviderForm();
    setReconnectTarget(null);
    setProviderKind(oauthConnected ? "openai" : "openai-codex");
    setProviderDialogOpen(true);
  }

  function openReconnectProvider(provider: ProviderStatus): void {
    resetProviderForm();
    setReconnectTarget(provider);
    setProviderKind(provider.kind);
    setProviderName(provider.name);
    setBaseUrl(provider.baseUrl ?? "");
    setProviderDialogOpen(true);
  }

  function changeProviderDialog(open: boolean): void {
    if (!open && providerBusy && providerKind === "openai-codex") {
      void window.lane.cancelOAuth();
    }
    setProviderDialogOpen(open);
    if (!open) {
      resetProviderForm();
      setReconnectTarget(null);
    }
  }

  async function connectProvider(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setProviderBusy(true);
    setProviderError("");
    try {
      const input: AddProviderInput = {
        ...(reconnectTarget ? { providerId: reconnectTarget.id } : {}),
        kind: providerKind as AddProviderInput["kind"],
        apiKey,
        ...(providerName.trim() ? { name: providerName.trim() } : {}),
        ...(providerKind === "custom-openai" && baseUrl.trim()
          ? { baseUrl: baseUrl.trim() }
          : {}),
      };
      setState(await window.lane.addProvider(input));
      resetProviderForm();
      setReconnectTarget(null);
      setProviderDialogOpen(false);
    } catch (error) {
      setProviderError(getErrorMessage(error));
    } finally {
      setProviderBusy(false);
    }
  }

  async function connectOAuth(): Promise<void> {
    setProviderBusy(true);
    setProviderError("");
    setOAuthStatus("Opening a secure browser sign-in…");
    try {
      setState(await window.lane.startOAuth());
      resetProviderForm();
      setReconnectTarget(null);
      setProviderDialogOpen(false);
    } catch (error) {
      setProviderError(getErrorMessage(error));
      // The flow is over, so the code field must go with it: submitting into a
      // finished flow silently does nothing and reads as success.
      setOAuthStatus("");
      setOAuthPrompt("");
      setOAuthCode("");
    } finally {
      setProviderBusy(false);
    }
  }

  async function submitOAuthCode(): Promise<void> {
    if (!oauthCode.trim()) return;
    try {
      await window.lane.submitOAuthCode(oauthCode.trim());
      setOAuthCode("");
    } catch (error) {
      setProviderError(getErrorMessage(error));
    }
  }

  async function removeProvider(): Promise<void> {
    if (!removeTarget) return;
    setRemoveBusy(true);
    try {
      setState(await window.lane.removeProvider(removeTarget.id));
      setRemoveTarget(null);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setRemoveBusy(false);
    }
  }

  async function clearActivity(): Promise<void> {
    setActivityClearing(true);
    try {
      setState(await window.lane.clearActivity());
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setActivityClearing(false);
    }
  }

  async function setActivityCapture(enabled: boolean): Promise<void> {
    setActivityCaptureBusy(true);
    try {
      setState(await window.lane.setActivityCapture(enabled));
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setActivityCaptureBusy(false);
    }
  }

  const recentActivity = activityItems(state.logs);
  const activityPanel = (
    <section aria-label="Activity" className="lane-activity-panel pb-6">
      <div className="flex items-center gap-3 pb-3">
        <h1 className="lane-section-title">Activity</h1>
        <div className="ml-auto flex items-center gap-2">
          <span className="lane-label text-muted-foreground">Capture bodies</span>
          <Switch
            aria-label="Capture raw request and response bodies"
            checked={state.activityCaptureEnabled}
            disabled={activityCaptureBusy}
            onCheckedChange={(checked) => void setActivityCapture(checked)}
          />
          <Button
            aria-label="Clear activity"
            disabled={activityClearing || recentActivity.length === 0}
            onClick={() => void clearActivity()}
            size="xs"
            variant="ghost"
          >
            {activityClearing ? "Clearing…" : "Clear"}
          </Button>
        </div>
      </div>
      {recentActivity.length === 0 ? (
        <p className="lane-meta rounded-lg bg-muted/35 px-4 py-10 text-center text-muted-foreground">
          No model requests yet
        </p>
      ) : (
        <ol className="divide-y rounded-lg bg-muted/20 px-3">
          {recentActivity.map((entry) => {
              const trace = entry.trace;
              if (!trace) return null;
              const running = trace.phase === "started";
              const failed = trace.cancelled || (trace.status ?? 0) >= 400;
              const statusLabel = trace.cancelled
                ? "Cancelled"
                : running
                  ? "Running"
                  : String(trace.status ?? "Done");
              const summary = (
                <>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="lane-label w-8 shrink-0 font-semibold text-muted-foreground">
                      {trace.method}
                    </span>
                    <code className="min-w-0 flex-1 truncate text-[0.75rem] font-medium text-foreground">
                      {trace.path}
                    </code>
                    <span
                      className={cn(
                        "lane-label shrink-0 tabular-nums text-muted-foreground",
                        failed && "text-destructive",
                      )}
                    >
                      {statusLabel}
                    </span>
                    {entry.capture && (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 pl-10 text-[0.6875rem] text-muted-foreground">
                    {traceDetails(trace).length > 0 && (
                      <span className="min-w-0 flex-1 truncate">
                        {traceDetails(trace).join(" · ")}
                      </span>
                    )}
                    <time className="ml-auto shrink-0 tabular-nums">
                      {new Date(entry.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                </>
              );
              return (
                <li className="py-2.5" key={entry.key}>
                  {entry.capture ? (
                    <Collapsible>
                      <CollapsibleTrigger className="group w-full cursor-default text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                        {summary}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-2 pl-10 pr-1 pb-1">
                        <CaptureDetails capture={entry.capture} />
                      </CollapsibleContent>
                    </Collapsible>
                  ) : (
                    summary
                  )}
                </li>
              );
          })}
        </ol>
      )}
    </section>
  );

  const settingsPanel = (
    <section>
      {/* The popover covers the page-level banner, so a failed setting has to
          report itself here or the switch just snaps back unexplained. */}
      {loadError && (
        <p
          className="lane-body mx-4 mt-3 rounded-lg bg-destructive/10 p-3 text-destructive"
          role="alert"
        >
          {loadError}
        </p>
      )}
      <div className="divide-y px-4">
        <div className="flex items-center justify-between gap-4 py-3">
          <p className="lane-value">Theme</p>
          <ThemeSetting />
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <p className="lane-value">Open at login</p>
          <Switch
            aria-label="Open Lane at login"
            checked={state.launchAtLogin}
            disabled={settingsBusy}
            onCheckedChange={(checked) => {
              void updateSetting(() => window.lane.setLaunchAtLogin(checked));
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <p className="lane-value">
            {window.lane.platform === "darwin" ? "Show in Dock" : "Show in taskbar"}
          </p>
          <Switch
            aria-label={
              window.lane.platform === "darwin"
                ? "Show Lane in Dock"
                : "Show Lane in taskbar"
            }
            checked={state.visibility.showDockIcon}
            disabled={settingsBusy}
            onCheckedChange={(checked) => {
              void updateSetting(() => window.lane.setDockIconVisible(checked));
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <p className="lane-value">
            {window.lane.platform === "darwin"
              ? "Show in menu bar"
              : "Show in system tray"}
          </p>
          <Switch
            aria-label={
              window.lane.platform === "darwin"
                ? "Show Lane in menu bar"
                : "Show Lane in system tray"
            }
            checked={state.visibility.showMenuBarIcon}
            disabled={settingsBusy}
            onCheckedChange={(checked) => {
              void updateSetting(() => window.lane.setMenuBarIconVisible(checked));
            }}
          />
        </div>

        <div className="py-3">
          <div className="flex items-center justify-between gap-4">
            <p className="lane-value">Command line</p>
            {cliIntegration?.installed ? (
              <span className="lane-meta text-muted-foreground">Installed</span>
            ) : (
              <Button
                disabled={cliBusy}
                focusableWhenDisabled
                onClick={() => void installCliIntegration()}
                size="sm"
                title="Install the lane command for local agents"
                variant="outline"
              >
                {cliBusy ? "Installing…" : "Install…"}
              </Button>
            )}
          </div>
          {cliError && (
            <p className="lane-meta mt-2 text-destructive" role="alert">
              {cliError}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="lane-value">About Lane</p>
            <p className="lane-meta mt-0.5 text-muted-foreground">{updateSummary}</p>
          </div>
          <Button
            disabled={updateChecking || updateState.status === "downloading"}
            focusableWhenDisabled
            onClick={() => {
              if (updateState.status === "available") {
                void window.lane.downloadUpdate();
              } else {
                void checkForUpdates();
              }
            }}
            size="sm"
            title={updateActionLabel}
            variant="outline"
          >
            {updateActionLabel}
          </Button>
        </div>
      </div>

      {!state.visibility.showDockIcon && !state.visibility.showMenuBarIcon && (
        <p className="lane-meta px-4 pt-3 text-muted-foreground">
          Lane keeps running in the background. Reopen it from Applications to
          show this window again.
        </p>
      )}

    </section>
  );

  return (
    <TooltipProvider delay={200}>
      <div className={cn("app-frame", window.lane.platform === "darwin" && "is-macos")}>
        {window.lane.platform === "darwin" && (
          <header className="window-chrome">
            <div className="window-navigation window-navigation-utilities">
              <UtilityControls
                activityOpen={activeView === "activity"}
                onActivityToggle={() =>
                  setActiveView((view) => view === "activity" ? "overview" : "activity")
                }
                onUpdateClick={() => void window.lane.downloadUpdate()}
                onSettingsOpenChange={setSettingsOpen}
                settingsOpen={settingsOpen}
                settingsContent={settingsPanel}
                updateState={updateState}
              />
            </div>
          </header>
        )}

        <div className="app-content bg-background">
          <ScrollArea className="h-full">
            <main className="min-h-full bg-background">
              <div
                className={cn(
                  "lane-page mx-auto w-full",
                  activeView === "activity" ? "is-activity" : "is-overview",
                )}
              >
                {window.lane.platform !== "darwin" && (
                  <div className="flex items-center justify-end gap-2 pb-4">
                    <UtilityControls
                      activityOpen={activeView === "activity"}
                      onActivityToggle={() =>
                        setActiveView((view) => view === "activity" ? "overview" : "activity")
                      }
                      onUpdateClick={() => void window.lane.downloadUpdate()}
                      onSettingsOpenChange={setSettingsOpen}
                      settingsOpen={settingsOpen}
                      settingsContent={settingsPanel}
                      updateState={updateState}
                    />
                  </div>
                )}

                {/* Both views raise this, and Activity and Settings have no
                    error slot of their own, so it renders above the switch. */}
                {loadError && (
                  <p
                    className="lane-body mb-4 rounded-lg bg-destructive/10 p-3 text-destructive"
                    role="alert"
                  >
                    {loadError}
                  </p>
                )}

                {activeView === "activity" ? (
                  activityPanel
                ) : (
                  <div className="lane-overview-grid">
                    <section
                      className="lane-overview-gateway scroll-mt-6 pb-2"
                      data-lane-section="gateway"
                      id="gateway"
                    >
              <div className="lane-section-heading">
                <h1 className="lane-section-title">Gateway</h1>
                <div className="flex items-center gap-2">
                  {gatewayBusy && (
                    <LoaderCircle
                      aria-label="Updating gateway"
                      className="size-3.5 animate-spin text-muted-foreground"
                    />
                  )}
                  <Switch
                    aria-label="Local gateway"
                    checked={state.gateway.running}
                    disabled={gatewayBusy}
                    onCheckedChange={(checked) => void toggleGateway(checked)}
                  />
                </div>
              </div>

              <div className="mt-3 divide-y divide-border/60 rounded-lg bg-muted/55">
                <div className="grid min-w-0 grid-cols-[6.75rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
                  <span className="lane-label text-muted-foreground">
                    API base URL
                  </span>
                  <code
                    aria-label="API base URL value"
                    className="lane-mono-value block truncate"
                  >
                    {apiBaseUrl}
                  </code>
                  <div className="flex items-center">
                    <ApiEndpointsDialog
                      clientKey={state.clientKey}
                      copied={copied}
                      copyValue={copyValue}
                      {...(state.defaultImageModel
                        ? { defaultImageModel: state.defaultImageModel }
                        : {})}
                      {...(state.defaultModel ? { defaultModel: state.defaultModel } : {})}
                      endpoint={state.gateway.endpoint}
                    />
                    <IconAction
                      label={copied === "base-url" ? "Copied" : "Copy API base URL"}
                      onClick={() => void copyValue(apiBaseUrl, "base-url")}
                    >
                      {copied === "base-url" ? <Check /> : <Clipboard />}
                    </IconAction>
                  </div>
                </div>
                <div className="grid min-w-0 grid-cols-[6.75rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
                  <span className="lane-label text-muted-foreground">
                    Client key
                  </span>
                  <code
                    aria-label="Client key value"
                    className="lane-mono-value block truncate"
                  >
                    {keyVisible ? state.clientKey : "••••••••••••••••••••"}
                  </code>
                  <div className="flex">
                    <IconAction
                      label={keyVisible ? "Hide client key" : "Reveal client key"}
                      onClick={() => setKeyVisible((visible) => !visible)}
                    >
                      {keyVisible ? <EyeOff /> : <Eye />}
                    </IconAction>
                    <IconAction
                      label={copied === "key" ? "Copied" : "Copy client key"}
                      onClick={() => void copyValue(state.clientKey, "key")}
                    >
                      {copied === "key" ? <Check /> : <Clipboard />}
                    </IconAction>
                  </div>
                </div>
              </div>

              {state.gateway.error && (
                <p className="lane-body mt-3 rounded-lg bg-destructive/10 p-3 text-destructive">
                  {state.gateway.error}
                </p>
              )}
              {state.credentialStorage.error && (
                <p className="lane-body mt-3 rounded-lg bg-destructive/10 p-3 text-destructive">
                  {state.credentialStorage.error}
                </p>
              )}
            </section>

            <section
              className="lane-overview-providers scroll-mt-6 py-2"
              data-lane-section="providers"
              id="providers"
            >
              <div className="lane-section-heading">
                <h2 className="lane-section-title">Connections</h2>
                <Dialog open={providerDialogOpen} onOpenChange={changeProviderDialog}>
                  <Button onClick={openAddProvider} size="sm" variant="outline">
                    <Plus data-icon="inline-start" />
                    Add provider
                  </Button>
                  <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                      <DialogTitle>
                        {reconnectTarget ? `Reconnect ${reconnectTarget.name}` : "Add provider"}
                      </DialogTitle>
                    </DialogHeader>

                    <div className="grid gap-5">
                      <label>
                        <FieldLabel>Provider</FieldLabel>
                        <Select
                          // Switching kind mid-sign-in would strand providerBusy
                          // and lose the cancel path for the running flow.
                          disabled={reconnectTarget !== null || providerBusy}
                          value={providerKind}
                          onValueChange={(value) => {
                            if (value) {
                              setProviderKind(value);
                              setProviderError("");
                              setOAuthStatus("");
                              setOAuthPrompt("");
                            }
                          }}
                        >
                          <SelectTrigger className="h-11 w-full px-3">
                            <span className="flex min-w-0 items-center gap-2.5">
                              <ProviderIcon
                                provider={{ kind: selectedProvider.value }}
                                size="sm"
                              />
                              <span className="truncate">{selectedProvider.label}</span>
                            </span>
                          </SelectTrigger>
                          <SelectContent alignItemWithTrigger={false}>
                            {PROVIDER_OPTIONS.map((option) => (
                              <SelectItem
                                className="min-h-14 rounded-lg px-2.5 py-2.5"
                                disabled={option.value === "openai-codex" && oauthConnected}
                                key={option.value}
                                value={option.value}
                              >
                                <span className="flex items-center gap-2.5">
                                  <ProviderIcon provider={{ kind: option.value }} size="sm" />
                                  <span className="flex min-w-0 flex-col items-start leading-tight">
                                    <span className="truncate">{option.label}</span>
                                    <span className="lane-meta mt-0.5 text-muted-foreground">
                                      {option.value === "openai-codex" && oauthConnected
                                        ? "Already connected"
                                        : option.description}
                                    </span>
                                  </span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>

                      {providerKind === "openai-codex" ? (
                        <div className="grid gap-4 rounded-lg bg-muted/55 p-4">
                          <div className="flex items-start gap-3">
                            <ProviderIcon provider={{ kind: "openai-codex" }} />
                            <div>
                              <h3 className="lane-value">Sign in with ChatGPT</h3>
                              <p className="lane-body mt-0.5 text-muted-foreground">
                                Lane opens your browser and stores the OAuth credential in secure
                                storage.
                              </p>
                            </div>
                          </div>
                          {oauthStatus && (
                            <p className="lane-body flex items-center gap-2 text-muted-foreground">
                              {providerBusy && (
                                <LoaderCircle className="size-4 animate-spin stroke-[1.8]" />
                              )}
                              {oauthStatus}
                            </p>
                          )}
                          {oauthPrompt && (
                            <label>
                              <FieldLabel>Authorization code or callback URL</FieldLabel>
                              <div className="flex gap-2">
                                <Input
                                  autoComplete="off"
                                  onChange={(event) => setOAuthCode(event.target.value)}
                                  value={oauthCode}
                                />
                                <Button
                                  disabled={!oauthCode.trim()}
                                  onClick={() => void submitOAuthCode()}
                                  variant="outline"
                                >
                                  Submit
                                </Button>
                              </div>
                            </label>
                          )}
                          <Button
                            disabled={providerBusy}
                            focusableWhenDisabled
                            onClick={() => void connectOAuth()}
                          >
                            {providerBusy && (
                              <LoaderCircle
                                className="size-4 animate-spin stroke-[1.8]"
                                data-icon="inline-start"
                              />
                            )}
                            {providerBusy ? "Waiting for browser…" : "Continue in browser"}
                          </Button>
                        </div>
                      ) : (
                        <form
                          className="grid gap-4"
                          onSubmit={(event) => void connectProvider(event)}
                        >
                          <label>
                            <FieldLabel>Display name</FieldLabel>
                            <Input
                              autoComplete="off"
                              onChange={(event) => setProviderName(event.target.value)}
                              placeholder="Optional"
                              value={providerName}
                            />
                          </label>
                          {providerKind === "custom-openai" && (
                            <label>
                              <FieldLabel>Base URL</FieldLabel>
                              <Input
                                autoComplete="off"
                                onChange={(event) => setBaseUrl(event.target.value)}
                                placeholder="http://127.0.0.1:11434/v1"
                                required
                                type="url"
                                value={baseUrl}
                              />
                            </label>
                          )}
                          <label>
                            <FieldLabel>API key</FieldLabel>
                            <Input
                              autoComplete="new-password"
                              onChange={(event) => setApiKey(event.target.value)}
                              required
                              type="password"
                              value={apiKey}
                            />
                            <span className="lane-meta mt-1.5 block text-muted-foreground">
                              Stored securely and never exposed to local clients.
                            </span>
                          </label>
                          <DialogFooter>
                            <DialogClose render={<Button type="button" variant="outline" />}>
                              Cancel
                            </DialogClose>
                            <Button
                              disabled={providerBusy || !apiKey.trim()}
                              focusableWhenDisabled
                              type="submit"
                            >
                              {providerBusy && (
                                <LoaderCircle
                                  className="size-4 animate-spin stroke-[1.8]"
                                  data-icon="inline-start"
                                />
                              )}
                              {providerBusy ? "Testing…" : "Test and connect"}
                            </Button>
                          </DialogFooter>
                        </form>
                      )}

                      {providerError && (
                        <p className="lane-body rounded-lg bg-destructive/10 p-3 text-destructive">
                          {providerError}
                        </p>
                      )}
                    </div>
                  </DialogContent>
                </Dialog>
              </div>

              <div className="mt-2 divide-y">
                {state.providers.length === 0 ? (
                  <p className="lane-meta px-3 py-3 text-muted-foreground">No providers</p>
                ) : (
                  state.providers.map((provider) => {
                    const modelCount =
                      provider.kind === "openai-codex"
                        ? new Set([
                            ...state.models
                              .filter((model) => model.provider === provider.id)
                              .map((model) => model.id),
                            ...state.imageModels
                              .filter((model) => model.provider === provider.id)
                              .map((model) => model.id),
                          ]).size
                        : provider.models.length;
                    return (
                      <div
                        className="lane-provider-row flex items-center gap-3"
                        key={provider.id}
                      >
                        <ProviderIcon provider={provider} />
                        <div className="min-w-0 flex-1">
                          <p className="lane-value truncate">{provider.name}</p>
                          <p className="lane-meta mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                provider.connected ? "bg-emerald-500" : "bg-amber-500",
                              )}
                            />
                            {provider.connected
                              ? `Connected · ${modelCount} ${modelCount === 1 ? "model" : "models"}`
                              : provider.needsReconnection
                                ? "Needs reconnection"
                                : provider.error || "Unavailable"}
                          </p>
                        </div>
                        {provider.needsReconnection && (
                          <Button
                            onClick={() => openReconnectProvider(provider)}
                            size="sm"
                            variant="outline"
                          >
                            Reconnect
                          </Button>
                        )}
                        <IconAction
                          destructive
                          label={`Remove ${provider.name}`}
                          onClick={() => setRemoveTarget(provider)}
                        >
                          <Trash2 />
                        </IconAction>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section
              className="lane-overview-models pb-2 pt-2"
              data-lane-section="models"
            >
              <h2 className="lane-models-heading lane-section-title">Model defaults</h2>
              <div className="lane-model-grid">
                <div className="lane-model-default grid min-w-0 gap-1.5">
                  <div className="flex items-center gap-1">
                    <p className="lane-label text-muted-foreground">Default model</p>
                    <Tooltip>
                      <TooltipTrigger
                        aria-label="About the default model"
                        render={
                          <button
                            className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            type="button"
                          />
                        }
                      >
                        <span className="inline-flex size-3 items-center justify-center rounded-full border border-current text-[8px] font-semibold leading-none">
                          i
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Used when an app doesn&apos;t specify a model.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Select
                    disabled={state.models.length === 0}
                    value={state.defaultModel ?? null}
                    onValueChange={(value) => {
                      if (value) {
                        void window.lane
                          .setDefaultModel(value)
                          .then(setState)
                          .catch((error: unknown) =>
                            setLoadError(getErrorMessage(error)),
                          );
                      }
                    }}
                  >
                    <SelectTrigger aria-label="Default model" className="h-9 w-full">
                      <span className="min-w-0 truncate">
                        {selectedModel?.name ?? "Choose a model"}
                      </span>
                    </SelectTrigger>
                    <SelectContent
                      align="end"
                      alignItemWithTrigger={false}
                      className="min-w-72"
                    >
                      {modelGroups.map((group) => (
                        <SelectGroup key={group.id}>
                          <SelectLabel className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.12em]">
                            {group.name}
                          </SelectLabel>
                          {group.models.map((model) => (
                            <SelectItem
                              className="min-h-9 rounded-lg py-2 pl-2.5"
                              key={model.id}
                              value={model.id}
                            >
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {supportsReasoningEffort && (
                  <div className="lane-model-effort grid min-w-0 gap-1.5">
                    <p className="lane-label text-muted-foreground">Effort</p>
                    <Select
                      value={displayedReasoningEffort}
                      onValueChange={(value) => {
                        if (
                          value === "low" ||
                          value === "medium" ||
                          value === "high" ||
                          value === "xhigh" ||
                          value === "max"
                        ) {
                          void window.lane
                            .setReasoningEffort(value)
                            .then(setState)
                            .catch((error: unknown) =>
                              setLoadError(getErrorMessage(error)),
                            );
                        }
                      }}
                    >
                      <SelectTrigger aria-label="Effort" className="h-9 w-full">
                        {reasoningEffortLabel(displayedReasoningEffort)}
                      </SelectTrigger>
                      <SelectContent align="end" alignItemWithTrigger={false}>
                        {REASONING_EFFORT_OPTIONS.filter((option) =>
                          supportedReasoningEfforts.includes(option.value),
                        ).map((option) => (
                          <SelectItem
                            className="min-h-9 py-2"
                            key={option.value}
                            value={option.value}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {supportsSpeedMode && (
                  <div className="lane-model-speed grid min-w-0 gap-1.5">
                    <p className="lane-label text-muted-foreground">Speed</p>
                    <Select
                      value={state.speedMode}
                      onValueChange={(value) => {
                        if (value === "standard" || value === "fast") {
                          void window.lane
                            .setSpeedMode(value)
                            .then(setState)
                            .catch((error: unknown) =>
                              setLoadError(getErrorMessage(error)),
                            );
                        }
                      }}
                    >
                      <SelectTrigger aria-label="Speed" className="h-9 w-full">
                        {state.speedMode === "fast" ? "Fast" : "Standard"}
                      </SelectTrigger>
                      <SelectContent
                        align="end"
                        alignItemWithTrigger={false}
                        width="content"
                      >
                        <SelectItem className="min-h-12 py-2" value="standard">
                          <span className="flex flex-col">
                            <span>Standard</span>
                            <span className="text-xs text-muted-foreground">
                              Default speed
                            </span>
                          </span>
                        </SelectItem>
                        <SelectItem className="min-h-12 py-2" value="fast">
                          <span className="flex flex-col">
                            <span>Fast</span>
                            <span className="text-xs text-muted-foreground">
                              Faster responses, more usage
                            </span>
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {state.imageModels.length > 0 && (
                <div className="lane-image-model mt-3 grid min-w-0 gap-1.5">
                  <div className="flex items-center gap-1">
                    <p className="lane-label text-muted-foreground">Image model</p>
                    <Tooltip>
                      <TooltipTrigger
                        aria-label="About the image model"
                        render={
                          <button
                            className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            type="button"
                          />
                        }
                      >
                        <span className="inline-flex size-3 items-center justify-center rounded-full border border-current text-[8px] font-semibold leading-none">
                          i
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {selectedImageIsGptImage2
                          ? selectedImageProvider?.kind === "openai-codex"
                            ? "Default for image generation. GPT Image 2 is opaque; Codex sizes are best effort."
                            : "Default for image generation. GPT Image 2 does not support transparent backgrounds."
                          : "Used when an image request doesn't specify a model."}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Select
                    value={state.defaultImageModel ?? null}
                    onValueChange={(value) => {
                      if (value) {
                        void window.lane
                          .setDefaultImageModel(value)
                          .then(setState)
                          .catch((error: unknown) =>
                            setLoadError(getErrorMessage(error)),
                          );
                      }
                    }}
                  >
                    <SelectTrigger aria-label="Image model" className="h-9 w-full">
                      <span className="min-w-0 truncate">
                        {selectedImageModel?.name ?? "Choose a model"}
                      </span>
                    </SelectTrigger>
                    <SelectContent
                      align="end"
                      alignItemWithTrigger={false}
                      className="min-w-72"
                    >
                      {imageModelGroups.map((group) => (
                        <SelectGroup key={group.id}>
                          <SelectLabel className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.12em]">
                            {group.name}
                          </SelectLabel>
                          {group.models.map((model) => (
                            <SelectItem
                              className="min-h-9 rounded-lg py-2 pl-2.5"
                              key={model.id}
                              value={model.id}
                            >
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
                    </section>
                  </div>
                )}
              </div>
            </main>
          </ScrollArea>
        </div>

      </div>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removeBusy) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>Remove {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Lane will delete this connection and its stored credential. You can connect it again
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removeBusy}
              focusableWhenDisabled
              onClick={() => void removeProvider()}
              variant="destructive"
            >
              {removeBusy ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

document.documentElement.dataset.platform = window.lane.platform;

createRoot(root).render(
  <ThemeProvider
    attribute="class"
    defaultTheme="system"
    disableTransitionOnChange
    enableColorScheme
    enableSystem
    nonce="lane-theme"
    storageKey="lane-theme"
  >
    <App />
  </ThemeProvider>,
);
