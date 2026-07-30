import type { PublicModel } from "../shared/contracts.ts";

export interface CanonicalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type CanonicalMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: CanonicalToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; toolName: string };

export interface CanonicalRequest {
  model?: string;
  systemPrompt?: string;
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  temperature?: number;
  maxTokens?: number;
}

export interface CanonicalImageRequest {
  model?: string;
  prompt: string;
  n?: number;
  quality?: "auto" | "low" | "medium" | "high";
  size?: string;
  background?: "auto" | "opaque" | "transparent";
  outputFormat?: "png" | "jpeg" | "webp";
  outputCompression?: number;
  moderation?: "auto" | "low";
  user?: string;
}

export interface CanonicalImage {
  b64Json: string;
  mimeType: string;
  revisedPrompt?: string;
}

export interface CanonicalImageResult {
  model: string;
  created: number;
  images: CanonicalImage[];
}

export type CanonicalEvent =
  | { type: "start"; model: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: CanonicalToolCall }
  | {
      type: "done";
      reason: "stop" | "length" | "tool_calls";
      usage: { input: number; output: number; total: number };
      responseId?: string;
    };

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "provider_error",
  ) {
    super(message);
  }
}

export interface ModelRuntime {
  listModels(): Promise<PublicModel[]> | PublicModel[];
  listImageModels?(): Promise<PublicModel[]> | PublicModel[];
  stream(request: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent>;
  generateImages?(
    request: CanonicalImageRequest,
    signal: AbortSignal,
  ): Promise<CanonicalImageResult>;
}
