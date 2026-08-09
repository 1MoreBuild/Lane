import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  GatewayCapture,
  GatewayTrace,
  LogEntry,
} from "../shared/contracts.ts";

const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:access|refresh|api[_ -]?key|token)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const LOG_FILE_PATTERN = /^activity-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_LOG_RETENTION_DAYS = 7;
export const DEFAULT_LOG_FILE_BYTES = 1024 * 1024;
export const DEFAULT_LOG_TOTAL_BYTES = 5 * 1024 * 1024;
export const DEFAULT_CAPTURE_TOTAL_BYTES = 32 * 1024 * 1024;

export function redact(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, (match, separator: string | undefined) => {
      if (/^Bearer/i.test(match)) return "Bearer [REDACTED]";
      if (separator) return `${match.slice(0, match.indexOf(separator) + separator.length)}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return text;
}

export interface LaneLoggerOptions {
  directory?: string;
  maxEntries?: number;
  retentionDays?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxCaptureBytes?: number;
  now?: () => number;
}

interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

interface WritableLogFile {
  path: string;
  created: boolean;
}

type LogListener = (entry: LogEntry) => void;

function cloneCapture(capture: GatewayCapture): GatewayCapture {
  return {
    ...(capture.request ? { request: { ...capture.request } } : {}),
    ...(capture.response ? { response: { ...capture.response } } : {}),
  };
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return redact(value).slice(0, maxLength);
}

function finiteInteger(value: unknown, minimum = 0): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum
    ? value
    : undefined;
}

function sanitizeGatewayTrace(value: unknown): GatewayTrace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const trace = value as Partial<GatewayTrace>;
  if (
    trace.kind !== "gateway" ||
    !["started", "completed"].includes(trace.phase ?? "")
  ) {
    return undefined;
  }
  const requestId = boundedText(trace.requestId, 64);
  const method = boundedText(trace.method, 12);
  const path = boundedText(trace.path, 160);
  if (!requestId || !method || !path || !path.startsWith("/")) return undefined;
  const result: GatewayTrace = {
    kind: "gateway",
    requestId,
    phase: trace.phase as GatewayTrace["phase"],
    method: method.toUpperCase(),
    path,
  };
  const model = boundedText(trace.model, 160);
  const provider = boundedText(trace.provider, 80);
  const status = finiteInteger(trace.status, 100);
  const durationMs = finiteInteger(trace.durationMs);
  const inputTokens = finiteInteger(trace.inputTokens);
  const outputTokens = finiteInteger(trace.outputTokens);
  const totalTokens = finiteInteger(trace.totalTokens);
  const imageCount = finiteInteger(trace.imageCount);
  const errorCode = boundedText(trace.errorCode, 80);
  if (typeof trace.stream === "boolean") result.stream = trace.stream;
  if (model) result.model = model;
  if (provider) result.provider = provider;
  if (status !== undefined) result.status = status;
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  if (imageCount !== undefined) result.imageCount = imageCount;
  if (errorCode) result.errorCode = errorCode;
  if (typeof trace.cancelled === "boolean") result.cancelled = trace.cancelled;
  return result;
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LogEntry>;
  return (
    typeof entry.timestamp === "number" &&
    Number.isFinite(entry.timestamp) &&
    ["info", "warn", "error"].includes(entry.level ?? "") &&
    typeof entry.message === "string" &&
    (entry.trace === undefined || sanitizeGatewayTrace(entry.trace) !== undefined)
  );
}

export class LaneLogger {
  private readonly entries: LogEntry[] = [];
  private readonly directory: string | undefined;
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxCaptureBytes: number;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;
  private persistenceEnabled: boolean;
  private lastCleanupAt = 0;
  private readonly listeners = new Set<LogListener>();

  constructor(options: LaneLoggerOptions = {}) {
    this.directory = options.directory;
    this.maxEntries = options.maxEntries ?? 200;
    this.retentionMs = (options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS) * DAY_MS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_LOG_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_LOG_TOTAL_BYTES;
    this.maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_CAPTURE_TOTAL_BYTES;
    this.now = options.now ?? Date.now;
    this.persistenceEnabled = this.directory !== undefined;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.directory) return;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await this.cleanup();
      await this.loadRecent();
    } catch (error) {
      this.persistenceEnabled = false;
      console.error(`Lane activity persistence unavailable: ${redact(error)}`);
    }
  }

  private async files(): Promise<LogFileInfo[]> {
    if (!this.directory) return [];
    const names = await readdir(this.directory);
    const files = await Promise.all(
      names
        .filter((name) => LOG_FILE_PATTERN.test(name))
        .map(async (name): Promise<LogFileInfo | undefined> => {
          const path = join(this.directory!, name);
          try {
            const metadata = await stat(path);
            if (!metadata.isFile()) return undefined;
            return { name, path, size: metadata.size, mtimeMs: metadata.mtimeMs };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        }),
    );
    return files.filter((file): file is LogFileInfo => file !== undefined);
  }

  private async cleanup(): Promise<void> {
    if (!this.directory || !this.persistenceEnabled) return;
    const cutoff = this.now() - this.retentionMs;
    const fresh: LogFileInfo[] = [];
    for (const file of await this.files()) {
      if (file.mtimeMs < cutoff) {
        await unlink(file.path);
      } else {
        await chmod(file.path, 0o600);
        fresh.push(file);
      }
    }

    let total = fresh.reduce((sum, file) => sum + file.size, 0);
    for (const file of fresh.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= this.maxTotalBytes) break;
      await unlink(file.path);
      total -= file.size;
    }
    this.lastCleanupAt = this.now();
  }

  private async loadRecent(): Promise<void> {
    const loaded: LogEntry[] = [];
    const files = (await this.files()).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      const lines = (await readFile(file.path, "utf8")).split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry: unknown = JSON.parse(line);
          if (isLogEntry(entry)) {
            const trace = entry.trace ? sanitizeGatewayTrace(entry.trace) : undefined;
            loaded.push({
              timestamp: entry.timestamp,
              level: entry.level,
              message: redact(entry.message),
              ...(trace ? { trace } : {}),
            });
          }
        } catch {
          // A partial final line must not hide earlier valid activity.
        }
      }
    }
    loaded.sort((a, b) => a.timestamp - b.timestamp);
    this.entries.splice(0, this.entries.length, ...loaded.slice(-this.maxEntries));
  }

  private datePrefix(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private async writablePath(timestamp: number): Promise<WritableLogFile> {
    const prefix = `activity-${this.datePrefix(timestamp)}`;
    const matching = (await this.files())
      .filter((file) => file.name === `${prefix}.jsonl` || file.name.startsWith(`${prefix}-`))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const latest = matching.at(-1);
    if (latest && latest.size < this.maxFileBytes) {
      return { path: latest.path, created: false };
    }
    const highestSegment = matching.reduce((highest, file) => {
      if (file.name === `${prefix}.jsonl`) return Math.max(highest, 0);
      const value = Number(file.name.slice(prefix.length + 1, -".jsonl".length));
      return Number.isInteger(value) ? Math.max(highest, value) : highest;
    }, -1);
    const segment = highestSegment + 1;
    return {
      path: join(
        this.directory!,
        segment === 0 ? `${prefix}.jsonl` : `${prefix}-${segment}.jsonl`,
      ),
      created: true,
    };
  }

  private async persist(entry: LogEntry): Promise<void> {
    if (!this.directory || !this.persistenceEnabled) return;
    if (this.now() - this.lastCleanupAt >= DAY_MS) await this.cleanup();
    const target = await this.writablePath(entry.timestamp);
    const { capture: _sessionOnlyCapture, ...persistedEntry } = entry;
    await appendFile(target.path, `${JSON.stringify(persistedEntry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(target.path, 0o600);
    if (target.created) await this.cleanup();
  }

  private trimCaptures(): void {
    let retainedBytes = 0;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (!entry?.capture) continue;
      const captureBytes =
        (entry.capture.request?.capturedBytes ?? 0) +
        (entry.capture.response?.capturedBytes ?? 0);
      if (retainedBytes + captureBytes <= this.maxCaptureBytes) {
        retainedBytes += captureBytes;
      } else {
        delete entry.capture;
      }
    }
  }

  log(
    level: LogEntry["level"],
    message: unknown,
    trace?: GatewayTrace,
    capture?: GatewayCapture,
  ): void {
    const sanitizedTrace = trace ? sanitizeGatewayTrace(trace) : undefined;
    const entry: LogEntry = {
      timestamp: this.now(),
      level,
      message: redact(message),
      ...(sanitizedTrace ? { trace: sanitizedTrace } : {}),
      ...(capture ? { capture: cloneCapture(capture) } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    this.trimCaptures();
    if (this.persistenceEnabled) {
      this.writeChain = this.writeChain
        .then(() => this.persist(entry))
        .catch(() => {
          // Activity persistence is diagnostic; it must never stop the gateway.
        });
    }
    for (const listener of this.listeners) {
      try {
        listener({
          ...entry,
          ...(entry.trace ? { trace: { ...entry.trace } } : {}),
          ...(entry.capture ? { capture: cloneCapture(entry.capture) } : {}),
        });
      } catch {
        // A UI observer must never interrupt the gateway or persistence.
      }
    }
  }

  trace(
    level: LogEntry["level"],
    message: unknown,
    trace: GatewayTrace,
    capture?: GatewayCapture,
  ): void {
    this.log(level, message, trace, capture);
  }

  info(message: unknown): void {
    this.log("info", message);
  }

  warn(message: unknown): void {
    this.log("warn", message);
  }

  error(message: unknown): void {
    this.log("error", message);
  }

  list(): LogEntry[] {
    return this.entries.map((entry) => ({
      ...entry,
      ...(entry.trace ? { trace: { ...entry.trace } } : {}),
      ...(entry.capture ? { capture: cloneCapture(entry.capture) } : {}),
    }));
  }

  async clear(): Promise<void> {
    this.entries.splice(0, this.entries.length);
    if (!this.directory || !this.persistenceEnabled) return;
    const clearPersisted = this.writeChain.then(async () => {
      for (const file of await this.files()) {
        try {
          await unlink(file.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      this.lastCleanupAt = this.now();
    });
    this.writeChain = clearPersisted.catch(() => {
      // Clearing diagnostics must not make future gateway logging unavailable.
    });
    await clearPersisted;
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}
