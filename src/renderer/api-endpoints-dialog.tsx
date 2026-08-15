import { useCallback, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Code2,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  buildLaneEndpointCurl,
  getLaneApiUrl,
  LANE_API_ROUTES,
} from "../shared/api-endpoints.ts";
import type {
  GatewayConnectivityProbe,
  GatewayConnectivityResult,
} from "../shared/contracts.ts";

const WSL_SETUP_STEPS = `# Add these lines to %USERPROFILE%\\.wslconfig:
[wsl2]
networkingMode=mirrored

# Then restart WSL from PowerShell:
wsl --shutdown`;

function probeMessage(
  probe: GatewayConnectivityProbe,
  target: "desktop" | "model" | "wsl",
): string {
  if (probe.status === "reachable") {
    const prefix = target === "wsl" && probe.environment
      ? `Reachable from ${probe.environment}`
      : target === "model"
        ? "The model returned a successful response"
        : "The local gateway responded";
    return probe.latencyMs === undefined ? prefix : `${prefix} · ${probe.latencyMs} ms`;
  }
  switch (probe.reason) {
    case "authentication_failed":
      return target === "model"
        ? "The provider rejected its credentials."
        : "Lane rejected the configured client key.";
    case "gateway_unavailable":
      return "Skipped because the local gateway is unavailable.";
    case "model_not_configured":
      return "Choose a default model before testing.";
    case "model_not_found":
      return "The provider could not find this model.";
    case "provider_unavailable":
      return "The provider or model is currently unavailable.";
    case "rate_limited":
      return "The provider rate-limited the test request.";
    case "request_timeout":
      return "The model request timed out.";
    case "unexpected_response":
      return "Lane returned an unexpected health response.";
    case "wsl_not_running":
      return "No WSL distribution is currently running.";
    case "wsl_unavailable":
      return "WSL is not installed or is unavailable.";
    case "probe_tool_missing":
      return probe.environment
        ? `curl is unavailable in ${probe.environment}.`
        : "The WSL connection test is unavailable.";
    default:
      return target === "wsl" && probe.environment
        ? `${probe.environment} cannot reach Windows localhost.`
        : "Lane API is not reachable on this computer.";
  }
}

function ProbeRow({
  label,
  probe,
  target,
}: {
  label: string;
  probe: GatewayConnectivityProbe | undefined;
  target: "desktop" | "model" | "wsl";
}) {
  const icon = !probe
    ? <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
    : probe.status === "reachable"
      ? <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      : probe.status === "unreachable"
        ? <CircleAlert className="size-3.5 text-destructive" />
        : <CircleDashed className="size-3.5 text-muted-foreground" />;
  return (
    <div className="flex min-w-0 items-start gap-2 py-1">
      <span className="mt-0.5 shrink-0" aria-hidden="true">{icon}</span>
      <div className="min-w-0">
        <p className="lane-label">{label}</p>
        <p className="lane-meta text-muted-foreground">
          {probe ? probeMessage(probe, target) : "Checking connection…"}
        </p>
      </div>
    </div>
  );
}

export function ApiEndpointsDialog({
  endpoint,
  clientKey,
  defaultModel,
  defaultImageModel,
  copied,
  copyValue,
}: {
  endpoint: string;
  clientKey: string;
  defaultModel?: string;
  defaultImageModel?: string;
  copied: string | null;
  copyValue: (value: string, target: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connectivity, setConnectivity] = useState<GatewayConnectivityResult>();
  const [checkError, setCheckError] = useState(false);

  const checkConnectivity = useCallback(async () => {
    setChecking(true);
    setCheckError(false);
    try {
      setConnectivity(await window.lane.testGatewayConnectivity());
    } catch {
      setCheckError(true);
    } finally {
      setChecking(false);
    }
  }, []);

  const wslNeedsMirroredNetworking =
    connectivity?.wsl?.status === "unreachable" &&
    connectivity.wsl.reason === "connection_failed";
  const modelReady = connectivity?.model.status === "reachable";
  const wslBlocked = connectivity?.wsl?.status === "unreachable";
  const fullyReady = modelReady && !wslBlocked;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setConnectivity(undefined);
          setCheckError(false);
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            aria-label="View API endpoints"
            className="px-2 text-muted-foreground hover:text-foreground"
            size="xs"
            variant="ghost"
          />
        }
      >
        <Code2 data-icon="inline-start" />
        Endpoints
      </DialogTrigger>
      <DialogContent className="gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>API endpoints</DialogTitle>
          <DialogDescription>
            Copy a ready-to-run request or test the complete path from Lane to your
            default model.
          </DialogDescription>
        </DialogHeader>

        <section className="rounded-lg bg-muted/55 px-3 py-2.5" aria-live="polite">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                {checking
                  ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                  : fullyReady
                    ? <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                    : connectivity || checkError
                      ? <CircleAlert className="size-4 text-destructive" />
                      : <CircleDashed className="size-4 text-muted-foreground" />}
              </span>
              <div className="min-w-0">
                <p className="lane-value">
                  {checking
                    ? "Testing connection…"
                    : fullyReady
                      ? "Ready"
                      : modelReady && wslBlocked
                        ? "WSL connection failed"
                      : connectivity || checkError
                        ? "Connection failed"
                        : "Not tested"}
                </p>
                <p className="lane-meta text-muted-foreground">
                  {checking
                    ? "Checking Lane, the provider, and the default model."
                    : fullyReady
                      ? "Lane and the default model are ready for requests."
                      : modelReady && wslBlocked
                        ? "The model works on Windows, but WSL cannot reach Lane."
                      : connectivity || checkError
                        ? "Review the diagnostic steps below, then try again."
                        : "Run a real model request to verify the complete path."}
                </p>
              </div>
            </div>
            <Button
              disabled={checking}
              onClick={() => void checkConnectivity()}
              size="xs"
              variant="outline"
            >
              <RefreshCw className={checking ? "animate-spin" : undefined} data-icon="inline-start" />
              {connectivity || checkError ? "Test again" : "Test connection"}
            </Button>
          </div>
          <p className="lane-meta mt-2 text-muted-foreground">
            Sends one minimal request to {defaultModel ?? "the default model"} and may
            use a small amount of provider quota.
          </p>
          {checkError ? (
            <p className="lane-meta mt-2 text-destructive" role="alert">
              Connection test failed. Try again.
            </p>
          ) : connectivity ? (
            <div className="mt-2 border-t border-border/60 pt-1">
              <ProbeRow
                label="Lane gateway"
                probe={connectivity?.desktop}
                target="desktop"
              />
              <ProbeRow
                label={defaultModel ? `Default model · ${defaultModel}` : "Default model"}
                probe={connectivity.model}
                target="model"
              />
              {window.lane.platform === "win32" && (
                <ProbeRow label="WSL" probe={connectivity?.wsl} target="wsl" />
              )}
            </div>
          ) : null}
          {wslNeedsMirroredNetworking && (
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
              <p className="lane-meta max-w-[22rem] text-muted-foreground">
                Enable WSL mirrored networking, restart WSL, then test again.
              </p>
              <Button
                onClick={() => void copyValue(WSL_SETUP_STEPS, "wsl-setup")}
                size="xs"
                variant="secondary"
              >
                {copied === "wsl-setup" ? <Check data-icon="inline-start" /> : null}
                {copied === "wsl-setup" ? "Copied" : "Copy WSL setup"}
              </Button>
            </div>
          )}
        </section>

        <div className="min-w-0 divide-y overflow-hidden">
          {LANE_API_ROUTES.map((route) => {
            const routeUrl = getLaneApiUrl(endpoint, route.path);
            const copyTarget = `curl:${route.path}`;
            return (
              <div className="flex min-w-0 items-center gap-3 py-2.5" key={route.path}>
                <span className="lane-label w-9 shrink-0 text-muted-foreground">
                  {route.method}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="lane-value">{route.label}</p>
                  <code className="lane-mono-value block truncate text-muted-foreground">
                    {routeUrl}
                  </code>
                </div>
                <Button
                  aria-label={`Copy ${route.label} cURL`}
                  onClick={() =>
                    void copyValue(
                      buildLaneEndpointCurl(endpoint, route.path, clientKey, {
                        ...(defaultModel ? { defaultModel } : {}),
                        ...(defaultImageModel ? { defaultImageModel } : {}),
                      }),
                      copyTarget,
                    )
                  }
                  size="xs"
                  variant="ghost"
                >
                  {copied === copyTarget
                    ? <Check data-icon="inline-start" />
                    : <Code2 data-icon="inline-start" />}
                  {copied === copyTarget ? "Copied" : "Copy cURL"}
                </Button>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
