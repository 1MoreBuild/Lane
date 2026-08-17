import type { ClaudeCliRuntime } from "./claude-cli.ts";
import type {
  CanonicalEvent,
  CanonicalImageRequest,
  CanonicalRequest,
  ModelRuntime,
} from "./runtime.ts";

// Routes chat requests between the HTTP-provider runtime and local CLI
// runtimes by model ownership; everything else stays with the primary runtime.
export class CompositeRuntime implements ModelRuntime {
  constructor(
    private readonly primary: ModelRuntime,
    private readonly cliRuntimes: readonly ClaudeCliRuntime[],
    private readonly defaultModel?: string,
  ) {}

  async listModels() {
    const primary = await this.primary.listModels();
    const cli = this.cliRuntimes.flatMap((runtime) => runtime.listModels());
    return [...primary, ...cli];
  }

  async listImageModels() {
    return (await this.primary.listImageModels?.()) ?? [];
  }

  stream(request: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    const requested = request.model ?? this.defaultModel;
    const owner = this.cliRuntimes.find((runtime) => runtime.ownsModel(requested));
    if (owner) {
      return owner.stream(
        { ...request, ...(requested ? { model: requested } : {}) },
        signal,
      );
    }
    return this.primary.stream(request, signal);
  }

  generateImages(request: CanonicalImageRequest, signal: AbortSignal) {
    if (!this.primary.generateImages) {
      throw new Error("No image providers are configured");
    }
    return this.primary.generateImages(request, signal);
  }
}
