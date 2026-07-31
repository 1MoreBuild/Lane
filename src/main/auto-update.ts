import type { AppUpdater } from "electron-updater";
import type { LaneUpdateState } from "../shared/contracts.ts";

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 30 * 60 * 1_000;

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
  private checking = false;
  private downloading = false;
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
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = false;

    this.updater.on("update-available", (info) => {
      this.availableVersion = info.version;
      this.onStateChanged({ status: "available", version: info.version });
    });
    this.updater.on("update-downloaded", (info) => {
      void this.install(info.version);
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
      this.logger.warn(`Automatic update check failed: ${error.message}`);
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

  async checkNow(): Promise<void> {
    if (!this.started || this.checking || this.downloading) return;
    this.checking = true;
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.logger.warn(`Automatic update check failed: ${String(error)}`);
    } finally {
      this.checking = false;
    }
  }

  async downloadAvailable(): Promise<void> {
    if (!this.availableVersion || this.downloading) return;
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
      this.downloading = false;
    }
  }

  private async install(version: string): Promise<void> {
    try {
      this.onStateChanged({ status: "downloading", version, percent: 100 });
      this.logger.info(`Installing Lane ${version}`);
      await this.prepareToInstall();
      this.updater.quitAndInstall(false, true);
    } catch (error) {
      this.logger.warn(`Automatic update install failed: ${String(error)}`);
      this.onStateChanged({ status: "available", version });
    }
  }
}
