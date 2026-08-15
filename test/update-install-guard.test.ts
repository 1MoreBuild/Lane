import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearUpdateInstallPending,
  findAuxiliaryLaneProcessIds,
  isUpdateInstallPending,
  prepareForUpdateInstall,
} from "../src/main/update-install-guard.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function markerPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lane-update-guard-"));
  temporaryDirectories.push(directory);
  return join(directory, "update-in-progress");
}

describe("update install guard", () => {
  it("finds only other processes launched from the exact Lane executable", () => {
    const executable = "/Applications/Lane.app/Contents/MacOS/Lane";
    const output = [
      `501 100 ${executable}`,
      `501 101 ${executable} models --json`,
      `501 102 ${executable} chrome-extension://approved`,
      `501 103 ${executable}.backup models`,
      "501 104 /Applications/Lane.app/Contents/Frameworks/Lane Helper.app/Contents/MacOS/Lane Helper",
      `502 105 ${executable} models --json`,
    ].join("\n");

    expect(findAuxiliaryLaneProcessIds(output, executable, 100, 501)).toEqual([
      101,
      102,
    ]);
  });

  it("canonicalizes the packaged launcher's lexical executable path", () => {
    const executable = "/Applications/Lane.app/Contents/MacOS/Lane";
    const launched =
      "/Applications/Lane.app/Contents/Resources/../MacOS/Lane models --json";
    const canonicalize = (path: string) =>
      path.replace("/Contents/Resources/../MacOS/", "/Contents/MacOS/");

    expect(
      findAuxiliaryLaneProcessIds(
        `501 101 ${launched}`,
        executable,
        100,
        501,
        canonicalize,
      ),
    ).toEqual([101]);
  });

  it("marks the install window and stops auxiliary Lane processes", async () => {
    const marker = await markerPath();
    const executable = "/Applications/Lane.app/Contents/MacOS/Lane";
    const processTables = [
      `501 100 ${executable}\n501 101 ${executable} models\n501 102 ${executable} chrome-extension://approved`,
      `501 100 ${executable}\n501 102 ${executable} chrome-extension://approved`,
      `501 100 ${executable}`,
    ];
    const kill = vi.fn();
    const listProcesses = vi.fn(
      async () => processTables.shift() ?? `501 100 ${executable}`,
    );
    const wait = vi.fn(async () => undefined);

    const stopped = await prepareForUpdateInstall({
      markerPath: marker,
      executablePath: executable,
      currentPid: 100,
      currentUserId: 501,
      platform: "darwin",
      listProcesses,
      killProcess: kill,
      wait,
      now: () => 1_000,
    });

    expect(stopped).toEqual([101, 102]);
    expect(kill.mock.calls).toEqual([
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [102, "SIGKILL"],
    ]);
    expect(listProcesses).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[600], [100]]);
    expect(isUpdateInstallPending(marker, () => 1_001)).toBe(true);
  });

  it("clears the marker on normal startup and ignores stale markers", async () => {
    const marker = await markerPath();
    await prepareForUpdateInstall({
      markerPath: marker,
      executablePath: "/Applications/Lane.app/Contents/MacOS/Lane",
      currentPid: 100,
      platform: "linux",
      listProcesses: async () => "",
      killProcess: vi.fn(),
      wait: async () => undefined,
      now: () => 1_000,
    });

    expect(isUpdateInstallPending(marker, () => 1_000 + 120_001)).toBe(false);
    expect(isUpdateInstallPending(marker, () => 1_001)).toBe(false);

    await prepareForUpdateInstall({
      markerPath: marker,
      executablePath: "/Applications/Lane.app/Contents/MacOS/Lane",
      currentPid: 100,
      platform: "linux",
      listProcesses: async () => "",
      killProcess: vi.fn(),
      wait: async () => undefined,
      now: () => 2_000,
    });
    clearUpdateInstallPending(marker);
    expect(isUpdateInstallPending(marker, () => 2_001)).toBe(false);
  });

  it("clears the install marker when auxiliary process discovery fails", async () => {
    const marker = await markerPath();

    await expect(
      prepareForUpdateInstall({
        markerPath: marker,
        executablePath: "/Applications/Lane.app/Contents/MacOS/Lane",
        currentPid: 100,
        currentUserId: 501,
        platform: "darwin",
        listProcesses: async () => {
          throw new Error("process table unavailable");
        },
        killProcess: vi.fn(),
        wait: async () => undefined,
        now: () => 3_000,
      }),
    ).rejects.toThrow("process table unavailable");

    expect(isUpdateInstallPending(marker, () => 3_001)).toBe(false);
  });

  it("aborts and clears the marker when a force-killed helper stays alive", async () => {
    const marker = await markerPath();
    const executable = "/Applications/Lane.app/Contents/MacOS/Lane";
    const table = `501 100 ${executable}\n501 101 ${executable} models`;
    const kill = vi.fn();
    const wait = vi.fn(async () => undefined);

    await expect(
      prepareForUpdateInstall({
        markerPath: marker,
        executablePath: executable,
        currentPid: 100,
        currentUserId: 501,
        platform: "darwin",
        listProcesses: async () => table,
        killProcess: kill,
        wait,
        now: () => 4_000,
      }),
    ).rejects.toThrow("Lane helper process did not exit before update installation");

    expect(kill.mock.calls).toEqual([
      [101, "SIGTERM"],
      [101, "SIGKILL"],
    ]);
    expect(wait).toHaveBeenCalledTimes(11);
    expect(isUpdateInstallPending(marker, () => 4_001)).toBe(false);
  });
});
