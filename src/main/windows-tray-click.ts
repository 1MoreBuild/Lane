const DEFAULT_SINGLE_CLICK_DELAY_MS = 250;
const DEFAULT_DOUBLE_CLICK_SUPPRESSION_MS = 500;

interface WindowsTrayClickOptions {
  togglePopup: () => void;
  openMainWindow: () => void;
  now?: () => number;
  scheduleTimeout?: typeof setTimeout;
  clearScheduledTimeout?: typeof clearTimeout;
  singleClickDelayMs?: number;
  doubleClickSuppressionMs?: number;
}

export class WindowsTrayClickController {
  private readonly togglePopup: () => void;
  private readonly openMainWindow: () => void;
  private readonly now: () => number;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly clearScheduledTimeout: typeof clearTimeout;
  private readonly singleClickDelayMs: number;
  private readonly doubleClickSuppressionMs: number;
  private pendingSingleClick: ReturnType<typeof setTimeout> | undefined;
  private suppressSingleClicksUntil = 0;

  constructor(options: WindowsTrayClickOptions) {
    this.togglePopup = options.togglePopup;
    this.openMainWindow = options.openMainWindow;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.scheduleTimeout ?? setTimeout;
    this.clearScheduledTimeout = options.clearScheduledTimeout ?? clearTimeout;
    this.singleClickDelayMs =
      options.singleClickDelayMs ?? DEFAULT_SINGLE_CLICK_DELAY_MS;
    this.doubleClickSuppressionMs =
      options.doubleClickSuppressionMs ?? DEFAULT_DOUBLE_CLICK_SUPPRESSION_MS;
  }

  handleClick(): void {
    if (this.now() < this.suppressSingleClicksUntil) return;
    this.cancelPendingSingleClick();
    this.pendingSingleClick = this.scheduleTimeout(() => {
      this.pendingSingleClick = undefined;
      if (this.now() >= this.suppressSingleClicksUntil) {
        this.togglePopup();
      }
    }, this.singleClickDelayMs);
  }

  handleDoubleClick(): void {
    this.suppressSingleClicksUntil = this.now() + this.doubleClickSuppressionMs;
    this.cancelPendingSingleClick();
    this.openMainWindow();
  }

  dispose(): void {
    this.cancelPendingSingleClick();
  }

  private cancelPendingSingleClick(): void {
    if (!this.pendingSingleClick) return;
    this.clearScheduledTimeout(this.pendingSingleClick);
    this.pendingSingleClick = undefined;
  }
}
