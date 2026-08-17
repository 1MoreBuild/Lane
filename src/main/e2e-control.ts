import { BrowserWindow, Menu, clipboard, dialog } from "electron";
import {
  isE2eControlAction,
  type E2eControlParams,
} from "../shared/e2e-control.ts";

// Main-process operations the packaged product tests need. Playwright used to
// reach these through the Node inspector, which required leaving the
// EnableNodeCliInspectArguments fuse on and with it a code-execution path into
// the signed binary. This module is registered only in E2E mode, which itself
// requires a temporary user-data profile, so it is absent from real installs.

let capturedClipboard = "";
let capturedDialogMessage: string | undefined;
let clipboardCaptured = false;

function mainWindow(): BrowserWindow {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) =>
    window.webContents.getURL().includes("index.html"),
  );
  if (!main) throw new Error("Lane main window is unavailable");
  return main;
}

function appMenuItems() {
  return Menu.getApplicationMenu()?.items[0]?.submenu?.items ?? [];
}

export async function runE2eControl(params: E2eControlParams): Promise<unknown> {
  const action = params.action;
  if (!isE2eControlAction(action)) throw new Error("Unsupported E2E action");

  if (action === "window-state") {
    const windows = BrowserWindow.getAllWindows();
    return {
      visible: windows.some((window) => window.isVisible()),
      menu_bar_visible: windows.some((window) => window.isMenuBarVisible()),
      window_count: windows.length,
    };
  }

  if (action === "set-window-size") {
    const { width, height } = params;
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error("Window size requires integer width and height");
    }
    mainWindow().setSize(width as number, height as number);
    return { ok: true };
  }

  if (action === "clipboard-text") {
    // Capture writes instead of reading the host clipboard, so a test run never
    // depends on or disturbs the developer's real clipboard.
    if (!clipboardCaptured) {
      clipboardCaptured = true;
      clipboard.writeText = (text: string) => {
        capturedClipboard = text;
      };
      return { text: "" };
    }
    return { text: capturedClipboard };
  }

  if (action === "menu-labels") {
    return { labels: appMenuItems().map((item) => item.label) };
  }

  if (action === "menu-click") {
    const target = appMenuItems().find((item) => item.label === params.label);
    if (!target?.click) {
      throw new Error(`Packaged menu item is unavailable: ${String(params.label)}`);
    }
    target.click(target, BrowserWindow.getFocusedWindow(), {} as KeyboardEvent);
    return { ok: true };
  }

  if (action === "push-update-state") {
    const channel = params.channel;
    if (typeof channel !== "string" || !channel.startsWith("lane:")) {
      throw new Error("A lane: channel is required");
    }
    mainWindow().webContents.send(channel, params.payload);
    return { ok: true };
  }

  if (action === "stub-dialogs") {
    capturedDialogMessage = undefined;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1);
      if (
        options &&
        typeof options === "object" &&
        "message" in options &&
        typeof options.message === "string"
      ) {
        capturedDialogMessage = options.message;
      }
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    return { ok: true };
  }

  return { message: capturedDialogMessage };
}
