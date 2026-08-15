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
      `100 ${executable}`,
      `101 ${executable} models --json`,
      `102 ${executable} chrome-extension://approved`,
      `103 ${executable}.backup models`,
      "104 /Applications/Lane.app/Contents/Frameworks/Lane Helper.app/Contents/MacOS/Lane Helper",
    ].join("\n");

    expect(findAuxiliaryLaneProcessIds(output, executable, 100)).toEqual([101, 102]);
  });

  it("marks the install window and stops auxiliary Lane processes", async () => {
    const marker = await markerPath();
    const executable = "/Applications/Lane.app/Contents/MacOS/Lane";
    const processTables = [
      `100 ${executable}\n101 ${executable} models\n102 ${executable} chrome-extension://approved`,
      `100 ${executable}\n102 ${executable} chrome-extension://approved`,
    ];
    const kill = vi.fn();

    const stopped = await prepareForUpdateInstall({
      markerPath: marker,
      executablePath: executable,
      currentPid: 100,
      platform: "darwin",
      listProcesses: async () => processTables.shift() ?? `100 ${executable}`,
      killProcess: kill,
      wait: async () => undefined,
      now: () => 1_000,
    });

    expect(stopped).toEqual([101, 102]);
    expect(kill.mock.calls).toEqual([
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [102, "SIGKILL"],
    ]);
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
});
