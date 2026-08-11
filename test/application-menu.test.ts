import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
  },
}));

import { laneApplicationMenuTemplate } from "../src/main/application-menu.ts";

describe("Lane application menu", () => {
  it("uses the public product name and exposes settings and updates", () => {
    const template = laneApplicationMenuTemplate({
      showAbout: vi.fn(),
      openSettings: vi.fn(),
      checkForUpdates: vi.fn(),
    });
    const applicationMenu = template[0];
    const items = Array.isArray(applicationMenu?.submenu)
      ? applicationMenu.submenu
      : [];
    const labels = items.flatMap((item) =>
      typeof item === "object" && "label" in item && item.label
        ? [item.label]
        : [],
    );

    expect(applicationMenu?.label).toBe("Lane");
    expect(labels).toEqual([
      "About Lane",
      "Settings…",
      "Check for Updates…",
      "Hide Lane",
      "Hide Others",
      "Show All",
      "Quit Lane",
    ]);
    expect(labels.join(" ")).not.toContain("lane-local-ai-gateway");
  });
});
