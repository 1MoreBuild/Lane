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
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
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
    expect((await stat(recentPath)).mode & 0o777).toBe(0o600);
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
});
