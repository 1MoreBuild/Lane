import { Menu, type MenuItemConstructorOptions } from "electron";

export interface LaneApplicationMenuActions {
  showAbout(): void;
  openSettings(): void;
  checkForUpdates(): void | Promise<void>;
}

export function laneApplicationMenuTemplate(
  actions: LaneApplicationMenuActions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: "Lane",
      submenu: [
        { label: "About Lane", click: actions.showAbout },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CommandOrControl+,",
          click: actions.openSettings,
        },
        {
          label: "Check for Updates…",
          click: () => void actions.checkForUpdates(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { label: "Hide Lane", accelerator: "Command+H", role: "hide" },
        { label: "Hide Others", accelerator: "Option+Command+H", role: "hideOthers" },
        { label: "Show All", role: "unhide" },
        { type: "separator" },
        { label: "Quit Lane", accelerator: "Command+Q", role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}

export function installLaneApplicationMenu(actions: LaneApplicationMenuActions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(laneApplicationMenuTemplate(actions)));
}
