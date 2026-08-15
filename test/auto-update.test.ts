import { EventEmitter } from "node:events";
import type { AppUpdater } from "electron-updater";
import { describe, expect, it, vi } from "vitest";
import { LaneAutoUpdate } from "../src/main/auto-update.ts";
import type { LaneUpdateState } from "../src/shared/contracts.ts";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async (): Promise<string[]> => []);
  quitAndInstall = vi.fn();
}

function updater(value: FakeUpdater): AppUpdater {
  return value as unknown as AppUpdater;
}

describe("automatic updates", () => {
  it("uses the stable channel and schedules standard periodic checks", async () => {
    const fake = new FakeUpdater();
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: vi.fn(),
      prepareToInstall: vi.fn(),
      scheduleTimeout: (callback, delay) => {
        callbacks.push(callback);
        delays.push(delay);
        return {};
      },
      scheduleInterval: (callback, delay) => {
        callbacks.push(callback);
        delays.push(delay);
        return {};
      },
    });

    controller.start();
    callbacks[0]!();
    await vi.waitFor(() => expect(fake.checkForUpdates).toHaveBeenCalledOnce());

    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(fake.autoRunAppAfterInstall).toBe(true);
    expect(fake.allowPrerelease).toBe(false);
    expect(delays).toEqual([15_000, 1_800_000]);
  });

  it("shows an available update, reports progress, and installs after download", async () => {
    const fake = new FakeUpdater();
    const states: LaneUpdateState[] = [];
    const prepareToInstall = vi.fn(async () => undefined);
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: (state) => states.push(state),
      prepareToInstall,
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();

    fake.emit("update-available", { version: "0.2.0" });
    await controller.downloadAvailable();
    fake.emit("download-progress", { percent: 47.6 });
    await vi.waitFor(() => expect(fake.downloadUpdate).toHaveBeenCalledOnce());
    fake.emit("update-downloaded", { version: "0.2.0" });
    await vi.waitFor(() => expect(fake.quitAndInstall).toHaveBeenCalledOnce());

    expect(states).toEqual([
      { status: "available", version: "0.2.0" },
      { status: "downloading", version: "0.2.0", percent: 0 },
      { status: "downloading", version: "0.2.0", percent: 47.6 },
      { status: "downloading", version: "0.2.0", percent: 100 },
    ]);
    expect(prepareToInstall).toHaveBeenCalledOnce();
  });

  it("does not download before the user clicks the update control", async () => {
    const fake = new FakeUpdater();
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: vi.fn(),
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();

    fake.emit("update-available", { version: "0.2.0" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it("coalesces repeated download clicks while one download is active", async () => {
    const fake = new FakeUpdater();
    let finishDownload: (() => void) | undefined;
    fake.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          finishDownload = () => resolve([]);
        }),
    );
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: vi.fn(),
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();
    fake.emit("update-available", { version: "0.2.0" });

    const first = controller.downloadAvailable();
    const second = controller.downloadAvailable();
    await vi.waitFor(() => expect(fake.downloadUpdate).toHaveBeenCalledOnce());
    finishDownload?.();
    await Promise.all([first, second]);

    expect(fake.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("returns a cancelled download to a retryable available state", async () => {
    const fake = new FakeUpdater();
    const states: LaneUpdateState[] = [];
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: (state) => states.push(state),
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();
    fake.emit("update-available", { version: "0.2.0" });
    fake.emit("update-cancelled", { version: "0.2.0" });
    await controller.downloadAvailable();

    expect(states.at(-1)).toEqual({
      status: "downloading",
      version: "0.2.0",
      percent: 0,
    });
    expect(fake.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("returns a failed download to a retryable available state", async () => {
    const fake = new FakeUpdater();
    fake.downloadUpdate.mockRejectedValueOnce(new Error("connection reset"));
    const states: LaneUpdateState[] = [];
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: (state) => states.push(state),
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();
    fake.emit("update-available", { version: "0.2.0" });
    await controller.downloadAvailable();
    await controller.downloadAvailable();

    expect(states).toContainEqual({
      status: "available",
      version: "0.2.0",
    });
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not install twice when the downloaded event is repeated", async () => {
    const fake = new FakeUpdater();
    const prepareToInstall = vi.fn(async () => undefined);
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: vi.fn(),
      prepareToInstall,
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();
    fake.emit("update-available", { version: "0.2.0" });
    fake.emit("update-downloaded", { version: "0.2.0" });
    fake.emit("update-downloaded", { version: "0.2.0" });
    await vi.waitFor(() => expect(fake.quitAndInstall).toHaveBeenCalledOnce());

    expect(prepareToInstall).toHaveBeenCalledOnce();
  });

  it("keeps a failed install retryable and does not ask the updater to quit", async () => {
    const fake = new FakeUpdater();
    const states: LaneUpdateState[] = [];
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: (state) => states.push(state),
      prepareToInstall: vi.fn(async () => {
        throw new Error("gateway did not stop");
      }),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();
    fake.emit("update-available", { version: "0.2.0" });
    fake.emit("update-downloaded", { version: "0.2.0" });
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({
        status: "available",
        version: "0.2.0",
      }),
    );

    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it("logs updater errors without opening a blocking dialog", async () => {
    const fake = new FakeUpdater();
    fake.checkForUpdates.mockRejectedValueOnce(new Error("network unavailable"));
    const warn = vi.fn();
    const onStateChanged = vi.fn();
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn },
      onStateChanged,
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();

    const result = await controller.checkNow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("network unavailable"),
    );
    expect(onStateChanged).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "error" });
  });

  it("reports whether a manual check is current or has an update", async () => {
    const current = new FakeUpdater();
    current.checkForUpdates.mockImplementationOnce(async () => {
      current.emit("update-not-available", { version: "0.1.5" });
      return null;
    });
    const currentController = new LaneAutoUpdate({
      updater: updater(current),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: vi.fn(),
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    currentController.start();

    const available = new FakeUpdater();
    available.checkForUpdates.mockImplementationOnce(async () => {
      available.emit("update-available", { version: "0.2.0" });
      return null;
    });
    const availableController = new LaneAutoUpdate({
      updater: updater(available),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: vi.fn(),
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    availableController.start();

    await expect(currentController.checkNow()).resolves.toEqual({
      status: "up-to-date",
    });
    await expect(availableController.checkNow()).resolves.toEqual({
      status: "available",
      version: "0.2.0",
    });
  });

  it("shares an active update check with a concurrent manual request", async () => {
    const fake = new FakeUpdater();
    let finishCheck: (() => void) | undefined;
    fake.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finishCheck = () => {
            fake.emit("update-not-available", { version: "0.1.10" });
            resolve(null);
          };
        }),
    );
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: vi.fn(),
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();

    const automatic = controller.checkNow();
    const manual = controller.checkNow();
    await vi.waitFor(() => expect(fake.checkForUpdates).toHaveBeenCalledOnce());
    finishCheck?.();

    await expect(Promise.all([automatic, manual])).resolves.toEqual([
      { status: "up-to-date" },
      { status: "up-to-date" },
    ]);
  });

  it("rate-limits automatic checks when the main window is reopened", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fake = new FakeUpdater();
    const controller = new LaneAutoUpdate({
      updater: updater(fake),
      logger: { info: vi.fn(), warn: vi.fn() },
      onStateChanged: vi.fn(),
      prepareToInstall: vi.fn(),
      scheduleTimeout: () => ({}),
      scheduleInterval: () => ({}),
    });
    controller.start();

    controller.checkWhenStale();
    await vi.waitFor(() => expect(fake.checkForUpdates).toHaveBeenCalledOnce());
    controller.checkWhenStale();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.checkForUpdates).toHaveBeenCalledOnce();

    now.mockReturnValue(1_300_001);
    controller.checkWhenStale();
    await vi.waitFor(() => expect(fake.checkForUpdates).toHaveBeenCalledTimes(2));
    now.mockRestore();
  });
});
