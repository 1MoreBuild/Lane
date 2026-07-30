import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  Models,
} from "@earendil-works/pi-ai";
import type { OAuthUiEvent } from "../shared/contracts.ts";
import { assertSafeOAuthAuthorizationUrl } from "./security.ts";

interface PendingPrompt {
  resolve(value: string): void;
  reject(error: Error): void;
}

export class OAuthCoordinator {
  private pending: PendingPrompt | undefined;
  private controller: AbortController | undefined;

  constructor(
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly emit: (event: OAuthUiEvent) => void,
  ) {}

  private notify = (event: AuthEvent): void => {
    if (event.type === "auth_url") {
      try {
        const url = assertSafeOAuthAuthorizationUrl(event.url);
        this.emit({ type: "auth_url", url: url.toString(), ...(event.instructions ? { instructions: event.instructions } : {}) });
        void this.openExternal(url.toString()).catch((error: unknown) => {
          this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        });
      } catch (error) {
        this.cancel();
        throw error;
      }
    } else if (event.type === "progress" || event.type === "info") {
      this.emit({ type: "progress", message: event.message });
    } else if (event.type === "device_code") {
      this.emit({
        type: "progress",
        message: `Open ${event.verificationUri} and enter ${event.userCode}`,
      });
    }
  };

  private prompt = async (prompt: AuthPrompt): Promise<string> => {
    if (prompt.type === "select") {
      const browser = prompt.options.find((option) => option.id === "browser");
      return browser?.id ?? prompt.options[0]?.id ?? "";
    }
    this.emit({ type: "prompt", promptType: prompt.type, message: prompt.message });
    return await new Promise<string>((resolve, reject) => {
      const abort = () => reject(new Error("OAuth login cancelled"));
      if (prompt.signal?.aborted || this.controller?.signal.aborted) return abort();
      prompt.signal?.addEventListener("abort", abort, { once: true });
      this.controller?.signal.addEventListener("abort", abort, { once: true });
      this.pending = {
        resolve: (value) => {
          prompt.signal?.removeEventListener("abort", abort);
          this.controller?.signal.removeEventListener("abort", abort);
          this.pending = undefined;
          resolve(value);
        },
        reject,
      };
    });
  };

  async login(models: Models): Promise<Credential> {
    if (this.controller) throw new Error("OAuth login is already in progress");
    process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";
    this.controller = new AbortController();
    const interaction: AuthInteraction = {
      signal: this.controller.signal,
      prompt: this.prompt,
      notify: this.notify,
    };
    try {
      return await models.login("openai-codex", "oauth", interaction);
    } finally {
      this.pending = undefined;
      this.controller = undefined;
    }
  }

  submit(code: string): void {
    if (!this.pending) throw new Error("No OAuth code prompt is active");
    if (!code.trim()) throw new Error("OAuth code is empty");
    this.pending.resolve(code.trim());
  }

  cancel(): void {
    this.controller?.abort();
    this.pending?.reject(new Error("OAuth login cancelled"));
    this.pending = undefined;
  }
}
