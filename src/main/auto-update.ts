import type { AppUpdater } from "electron-updater";
import type {
  LaneUpdateCheckResult,
  LaneUpdateState,
} from "../shared/contracts.ts";

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 30 * 60 * 1_000;
const REOPEN_CHECK_INTERVAL_MS = 5 * 60 * 1_000;

interface UpdateLogger {
  info(message: unknown): void;
  warn(message: unknown): void;
}

interface TimerHandle {
  unref?(): unknown;
}

type Schedule = (callback: () => void, delay: number) => TimerHandle;

export interface LaneAutoUpdateOptions {
  updater: AppUpdater;
  logger: UpdateLogger;
  onStateChanged(state: LaneUpdateState): void;
  prepareToInstall(): Promise<void>;
  scheduleTimeout?: Schedule;
  scheduleInterval?: Schedule;
}

export class LaneAutoUpdate {
  private readonly updater: AppUpdater;
  private readonly logger: UpdateLogger;
  private readonly onStateChanged: LaneAutoUpdateOptions["onStateChanged"];
  private readonly prepareToInstall: LaneAutoUpdateOptions["prepareToInstall"];
  private readonly scheduleTimeout: Schedule;
  private readonly scheduleInterval: Schedule;
  private started = false;
  private checkPromise: Promise<LaneUpdateCheckResult> | undefined;
  private lastCheckCompletedAt = 0;
  private downloading = false;
  private installing = false;
  private availableVersion: string | undefined;

  constructor(options: LaneAutoUpdateOptions) {
    this.updater = options.updater;
    this.logger = options.logger;
    this.onStateChanged = options.onStateChanged;
    this.prepareToInstall = options.prepareToInstall;
    this.scheduleTimeout =
      options.scheduleTimeout ??
      ((callback, delay) => setTimeout(callback, delay));
    this.scheduleInterval =
      options.scheduleInterval ??
      ((callback, delay) => setInterval(callback, delay));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.updater.autoDownload = false;
    // Installation must always pass through prepareToInstall so helper
    // processes cannot keep the app bundle open during replacement.
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = false;
    this.updater.logger = {
      info: (message) => this.logger.info(`Updater: ${String(message)}`),
      warn: (message) => this.logger.warn(`Updater: ${String(message)}`),
      error: (message) => this.logger.warn(`Updater: ${String(message)}`),
      debug: () => undefined,
    };

    this.updater.on("update-available", (info) => {
      this.availableVersion = info.version;
      this.onStateChanged({ status: "available", version: info.version });
    });
    this.updater.on("update-downloaded", (info) => {
      void this.install(info.version);
    });
    this.updater.on("update-cancelled", (info) => {
      this.downloading = false;
      this.availableVersion = info.version;
      this.logger.warn(`Lane ${info.version} update download was cancelled`);
      this.onStateChanged({ status: "available", version: info.version });
    });
    this.updater.on("download-progress", (progress) => {
      if (!this.availableVersion) return;
      this.onStateChanged({
        status: "downloading",
        version: this.availableVersion,
        percent: Math.min(100, Math.max(0, progress.percent)),
      });
    });
    this.updater.on("update-not-available", () => {
      this.logger.info("Lane is up to date");
      this.availableVersion = undefined;
      this.onStateChanged({ status: "idle" });
    });
    this.updater.on("error", (error) => {
      if (!this.installing) this.downloading = false;
      this.logger.warn(`Automatic update error: ${error.message}`);
      if (this.availableVersion) {
        this.onStateChanged({
          status: "available",
          version: this.availableVersion,
        });
      }
    });

    this.scheduleTimeout(() => void this.checkNow(), FIRST_CHECK_DELAY_MS).unref?.();
    this.scheduleInterval(() => void this.checkNow(), CHECK_INTERVAL_MS).unref?.();
  }

  checkWhenStale(): void {
    if (Date.now() - this.lastCheckCompletedAt < REOPEN_CHECK_INTERVAL_MS) return;
    void this.checkNow();
  }

  checkNow(): Promise<LaneUpdateCheckResult> {
    if (!this.started) return Promise.resolve({ status: "unavailable" });
    if (this.downloading || this.installing) return Promise.resolve({ status: "busy" });
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.runCheck().finally(() => {
      this.lastCheckCompletedAt = Date.now();
      this.checkPromise = undefined;
    });
    return this.checkPromise;
  }

  private async runCheck(): Promise<LaneUpdateCheckResult> {
    try {
      await this.updater.checkForUpdates();
      return this.availableVersion
        ? { status: "available", version: this.availableVersion }
        : { status: "up-to-date" };
    } catch (error) {
      this.logger.warn(`Automatic update check failed: ${String(error)}`);
      return this.availableVersion
        ? { status: "available", version: this.availableVersion }
        : { status: "error" };
    }
  }

  async downloadAvailable(): Promise<void> {
    if (!this.availableVersion || this.downloading || this.installing) return;
    const version = this.availableVersion;
    this.downloading = true;
    this.onStateChanged({ status: "downloading", version, percent: 0 });
    try {
      this.logger.info(`Downloading Lane ${version}`);
      await this.updater.downloadUpdate();
    } catch (error) {
      this.logger.warn(`Automatic update download failed: ${String(error)}`);
      this.onStateChanged({ status: "available", version });
    } finally {
      if (!this.installing) this.downloading = false;
    }
  }

  private async install(version: string): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    try {
      this.onStateChanged({ status: "downloading", version, percent: 100 });
      this.logger.info(`Installing Lane ${version}`);
      await this.prepareToInstall();
      // Preparation established the install guard, so the standard fallback is
      // now safe if the immediate handoff is interrupted.
      this.updater.autoInstallOnAppQuit = true;
      this.updater.quitAndInstall(false, true);
    } catch (error) {
      this.updater.autoInstallOnAppQuit = false;
      this.installing = false;
      this.downloading = false;
      this.logger.warn(`Automatic update install failed: ${String(error)}`);
      this.onStateChanged({ status: "available", version });
    }
  }
}
