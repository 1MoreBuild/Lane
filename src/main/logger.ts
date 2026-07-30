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
import type { LogEntry } from "../shared/contracts.ts";

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

function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LogEntry>;
  return (
    typeof entry.timestamp === "number" &&
    Number.isFinite(entry.timestamp) &&
    ["info", "warn", "error"].includes(entry.level ?? "") &&
    typeof entry.message === "string"
  );
}

export class LaneLogger {
  private readonly entries: LogEntry[] = [];
  private readonly directory: string | undefined;
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;
  private persistenceEnabled: boolean;
  private lastCleanupAt = 0;

  constructor(options: LaneLoggerOptions = {}) {
    this.directory = options.directory;
    this.maxEntries = options.maxEntries ?? 200;
    this.retentionMs = (options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS) * DAY_MS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_LOG_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_LOG_TOTAL_BYTES;
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
            loaded.push({ ...entry, message: redact(entry.message) });
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
    await appendFile(target.path, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(target.path, 0o600);
    if (target.created) await this.cleanup();
  }

  log(level: LogEntry["level"], message: unknown): void {
    const entry: LogEntry = {
      timestamp: this.now(),
      level,
      message: redact(message),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    if (this.persistenceEnabled) {
      this.writeChain = this.writeChain
        .then(() => this.persist(entry))
        .catch(() => {
          // Activity persistence is diagnostic; it must never stop the gateway.
        });
    }
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
    return this.entries.map((entry) => ({ ...entry }));
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}
