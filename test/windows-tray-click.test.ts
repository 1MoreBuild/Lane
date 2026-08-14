import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsTrayClickController } from "../src/main/windows-tray-click.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("Windows tray clicks", () => {
  it("opens the tray popup after a single click", () => {
    vi.useFakeTimers();
    const togglePopup = vi.fn();
    const controller = new WindowsTrayClickController({
      togglePopup,
      openMainWindow: vi.fn(),
    });

    controller.handleClick();
    vi.advanceTimersByTime(249);
    expect(togglePopup).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(togglePopup).toHaveBeenCalledOnce();
  });

  it("opens the main window without reopening the popup after a double click", () => {
    vi.useFakeTimers();
    const togglePopup = vi.fn();
    const openMainWindow = vi.fn();
    const controller = new WindowsTrayClickController({
      togglePopup,
      openMainWindow,
    });

    controller.handleClick();
    controller.handleDoubleClick();
    controller.handleClick();
    vi.advanceTimersByTime(1_000);

    expect(openMainWindow).toHaveBeenCalledOnce();
    expect(togglePopup).not.toHaveBeenCalled();
  });

  it("cancels a pending single click when disposed", () => {
    vi.useFakeTimers();
    const togglePopup = vi.fn();
    const controller = new WindowsTrayClickController({
      togglePopup,
      openMainWindow: vi.fn(),
    });

    controller.handleClick();
    controller.dispose();
    vi.runAllTimers();

    expect(togglePopup).not.toHaveBeenCalled();
  });
});
