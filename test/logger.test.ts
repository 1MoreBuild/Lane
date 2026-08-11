import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LaneLogger } from "../src/main/logger.ts";
import { tempPath } from "./helpers.ts";

describe("persistent activity log", () => {
  it("restores redacted activity after restart with private permissions", async () => {
    const directory = await tempPath("logs");
    const timestamp = Date.UTC(2026, 6, 30, 12);
    const first = new LaneLogger({ directory, now: () => timestamp });
    await first.initialize();
    first.info("Connected with api_key=sk-supersecret123");
    await first.flush();

    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    const path = join(directory, names[0]!);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path, "utf8")).not.toContain("supersecret");

    const second = new LaneLogger({ directory, now: () => timestamp + 1_000 });
    await second.initialize();
    expect(second.list()).toEqual([
      {
        timestamp,
        level: "info",
        message: "Connected with api_key=[REDACTED]",
      },
    ]);
  });

  it("deletes files older than the retention window", async () => {
    const directory = await tempPath("logs");
    await mkdir(directory, { recursive: true });
    const now = Date.UTC(2026, 6, 30, 12);
    const oldPath = join(directory, "activity-2026-07-01.jsonl");
    const recentPath = join(directory, "activity-2026-07-29.jsonl");
    await writeFile(oldPath, "");
    await writeFile(recentPath, "");
    const old = new Date(now - 30 * 24 * 60 * 60 * 1_000);
    const recent = new Date(now - 24 * 60 * 60 * 1_000);
    await utimes(oldPath, old, old);
    await utimes(recentPath, recent, recent);

    const logger = new LaneLogger({ directory, retentionDays: 7, now: () => now });
    await logger.initialize();
    expect(await readdir(directory)).toEqual(["activity-2026-07-29.jsonl"]);
  });

  it("bounds aggregate storage by removing the oldest files first", async () => {
    const directory = await tempPath("logs");
    await mkdir(directory, { recursive: true });
    const now = Date.UTC(2026, 6, 30, 12);
    const oldPath = join(directory, "activity-2026-07-29.jsonl");
    const recentPath = join(directory, "activity-2026-07-30.jsonl");
    await writeFile(oldPath, "a".repeat(80));
    await writeFile(recentPath, "b".repeat(80));
    await chmod(oldPath, 0o644);
    const old = new Date(now - 60_000);
    const recent = new Date(now);
    await utimes(oldPath, old, old);
    await utimes(recentPath, recent, recent);

    const logger = new LaneLogger({
      directory,
      retentionDays: 7,
      maxTotalBytes: 100,
      now: () => now,
    });
    await logger.initialize();
    expect(await readdir(directory)).toEqual(["activity-2026-07-30.jsonl"]);
    if (process.platform !== "win32") {
      expect((await stat(recentPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates the current day when a file reaches its size bound", async () => {
    const directory = await tempPath("logs");
    const now = Date.UTC(2026, 6, 30, 12);
    const logger = new LaneLogger({
      directory,
      maxFileBytes: 90,
      now: () => now,
    });
    await logger.initialize();
    logger.info("first activity entry");
    logger.info("second activity entry");
    logger.info("third activity entry");
    await logger.flush();
    expect((await readdir(directory)).length).toBeGreaterThan(1);
  });

  it("does not reuse a rotated segment number when earlier segments are missing", async () => {
    const directory = await tempPath("logs");
    const now = Date.UTC(2026, 6, 30, 12);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "activity-2026-07-30.jsonl"), "a".repeat(100));
    await writeFile(join(directory, "activity-2026-07-30-2.jsonl"), "b".repeat(100));

    const logger = new LaneLogger({
      directory,
      maxFileBytes: 90,
      now: () => now,
    });
    await logger.initialize();
    logger.info("new activity entry");
    await logger.flush();

    expect(await readdir(directory)).toContain("activity-2026-07-30-3.jsonl");
  });

  it("keeps the gateway usable when persistence cannot be initialized", async () => {
    const path = await tempPath("logs-file");
    await writeFile(path, "not a directory");
    const logger = new LaneLogger({ directory: path });

    await expect(logger.initialize()).resolves.toBeUndefined();
    logger.info("still available");
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(logger.list().at(-1)?.message).toBe("still available");
  });

  it("persists sanitized structured traces and publishes live entries", async () => {
    const directory = await tempPath("trace-logs");
    const logger = new LaneLogger({ directory, now: () => 42 });
    const received: unknown[] = [];
    const unsubscribe = logger.subscribe((entry) => received.push(entry));
    await logger.initialize();

    logger.trace("info", "POST /v1/responses", {
      kind: "gateway",
      requestId: "request-1",
      phase: "completed",
      method: "post",
      path: "/v1/responses",
      model: "mock/mock-model",
      provider: "mock",
      status: 200,
      durationMs: 17,
      inputTokens: 4,
      outputTokens: 8,
      totalTokens: 12,
    });
    unsubscribe();
    await logger.flush();

    expect(received).toHaveLength(1);
    expect(logger.list()[0]?.trace).toMatchObject({
      method: "POST",
      model: "mock/mock-model",
      status: 200,
      totalTokens: 12,
    });
    const persisted = await readFile(join(directory, (await readdir(directory))[0]!), "utf8");
    expect(persisted).toContain('"kind":"gateway"');
    expect(persisted).not.toContain("Authorization");
  });

  it("keeps raw captures in memory for the current session and never persists them", async () => {
    const directory = await tempPath("capture-logs");
    const logger = new LaneLogger({ directory, now: () => 42 });
    await logger.initialize();
    logger.trace(
      "info",
      "POST /v1/responses",
      {
        kind: "gateway",
        requestId: "request-capture",
        phase: "completed",
        method: "POST",
        path: "/v1/responses",
        status: 200,
      },
      {
        request: {
          body: '{"input":"sk-exact-raw-value"}',
          contentType: "application/json",
          capturedBytes: 30,
          totalBytes: 30,
          truncated: false,
        },
      },
    );
    await logger.flush();

    expect(logger.list()[0]?.capture?.request?.body).toBe(
      '{"input":"sk-exact-raw-value"}',
    );
    const persisted = await readFile(join(directory, (await readdir(directory))[0]!), "utf8");
    expect(persisted).not.toContain("sk-exact-raw-value");
    expect(persisted).not.toContain('"capture"');

    const restored = new LaneLogger({ directory, now: () => 43 });
    await restored.initialize();
    expect(restored.list()[0]?.capture).toBeUndefined();
  });

  it("drops the oldest raw bodies when the session capture budget is full", async () => {
    const logger = new LaneLogger({ maxCaptureBytes: 10 });
    await logger.initialize();
    const trace = (requestId: string) => ({
      kind: "gateway" as const,
      requestId,
      phase: "completed" as const,
      method: "POST",
      path: "/v1/responses",
      status: 200,
    });
    const capture = (body: string) => ({
      request: {
        body,
        capturedBytes: Buffer.byteLength(body),
        totalBytes: Buffer.byteLength(body),
        truncated: false,
      },
    });

    logger.trace("info", "first", trace("first"), capture("123456"));
    logger.trace("info", "second", trace("second"), capture("abcdef"));

    expect(logger.list()[0]?.capture).toBeUndefined();
    expect(logger.list()[1]?.capture?.request?.body).toBe("abcdef");
  });

  it("evicts captures strictly from oldest to newest when sizes differ", async () => {
    const logger = new LaneLogger({ maxCaptureBytes: 10 });
    await logger.initialize();
    const trace = (requestId: string) => ({
      kind: "gateway" as const,
      requestId,
      phase: "completed" as const,
      method: "POST",
      path: "/v1/responses",
      status: 200,
    });
    const capture = (body: string) => ({
      request: {
        body,
        capturedBytes: Buffer.byteLength(body),
        totalBytes: Buffer.byteLength(body),
        truncated: false,
      },
    });

    logger.trace("info", "oldest", trace("oldest"), capture("123"));
    logger.trace("info", "middle", trace("middle"), capture("123456789"));
    logger.trace("info", "newest", trace("newest"), capture("abc"));

    const entries = logger.list();
    expect(entries[0]?.capture).toBeUndefined();
    expect(entries[1]?.capture).toBeUndefined();
    expect(entries[2]?.capture?.request?.body).toBe("abc");
  });

  it("clears memory and persisted history before accepting new entries", async () => {
    const directory = await tempPath("clear-logs");
    let timestamp = 1;
    const logger = new LaneLogger({ directory, now: () => timestamp });
    await logger.initialize();
    logger.info("old activity");

    const clearing = logger.clear();
    timestamp = 2;
    logger.info("new activity");
    await clearing;
    await logger.flush();

    expect(logger.list().map((entry) => entry.message)).toEqual(["new activity"]);
    const contents = await Promise.all(
      (await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")),
    );
    expect(contents.join("\n")).not.toContain("old activity");
    expect(contents.join("\n")).toContain("new activity");
  });
});
