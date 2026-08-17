import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CliInstaller,
  restoreEnabledCliIntegration,
  WINDOWS_CLI_MARKER,
} from "../src/main/cli-install.ts";
import { tempPath } from "./helpers.ts";

describe("CLI installer", () => {
  it("restores a missing command when CLI integration was already enabled", async () => {
    const install = vi.fn(async () => ({
      enabled: true,
      installed: true,
      command: "lane",
    }));
    const getState = vi.fn(async () => ({
      enabled: true,
      installed: false,
      command: "lane",
    }));

    await restoreEnabledCliIntegration({ getState, install }, true);

    expect(getState).toHaveBeenCalledWith(true);
    expect(install).toHaveBeenCalledOnce();
  });

  it("leaves command integration untouched when it was disabled", async () => {
    const integration = {
      getState: vi.fn(),
      install: vi.fn(),
    };

    await restoreEnabledCliIntegration(integration, false);

    expect(integration.getState).not.toHaveBeenCalled();
    expect(integration.install).not.toHaveBeenCalled();
  });

  it("installs and detects the launcher through an injected privileged boundary", async () => {
    const executable = await tempPath("Lane");
    const launcher = await tempPath("lane-cli");
    const first = await tempPath("usr-local/bin/lane");
    const second = await tempPath("homebrew/bin/lane");
    await writeFile(executable, "binary");
    await writeFile(launcher, "launcher");
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: launcher,
      platform: "darwin",
      linkPaths: [first, second],
      runPrivileged: async () => {
        for (const path of [first, second]) {
          await mkdir(dirname(path), { recursive: true });
          await symlink(launcher, path);
        }
      },
    });

    expect(await installer.getState(false)).toMatchObject({
      enabled: false,
      installed: false,
      command: "lane",
    });
    expect(await installer.install()).toMatchObject({
      enabled: true,
      installed: true,
      command: "lane",
      path: first,
    });
  });

  it("refuses to replace an unrelated command", async () => {
    const executable = await tempPath("Lane");
    const launcher = await tempPath("lane-cli");
    const link = await tempPath("bin/lane");
    await writeFile(executable, "binary");
    await writeFile(launcher, "launcher");
    await mkdir(dirname(link), { recursive: true });
    await writeFile(link, "unrelated");
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: launcher,
      platform: "darwin",
      linkPaths: [link],
      runPrivileged: async () => {
        throw new Error("must not run");
      },
    });
    await expect(installer.install()).rejects.toThrow(
      `Another command already exists at ${link}`,
    );
  });

  it("repairs a symlink owned by an older Lane app bundle", async () => {
    const executable = await tempPath("current/Lane.app/Contents/MacOS/Lane");
    const launcher = await tempPath("current/Lane.app/Contents/Resources/bin/lane");
    const oldApp = await tempPath("old/Lane.app");
    const oldExecutable = join(oldApp, "Contents/MacOS/Lane");
    const link = await tempPath("bin/lane");
    for (const path of [executable, launcher, oldExecutable]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "binary");
    }
    await mkdir(dirname(link), { recursive: true });
    await symlink(oldExecutable, link);
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: launcher,
      platform: "darwin",
      linkPaths: [link],
      readBundleIdentifier: async () => "works.earendil.lane",
      runPrivileged: async () => {
        await unlink(link);
        await symlink(launcher, link);
      },
    });

    expect(await installer.install()).toMatchObject({
      installed: true,
      path: link,
    });
  });

  it("does not replace a symlink from another app bundle", async () => {
    const executable = await tempPath("current/Lane.app/Contents/MacOS/Lane");
    const launcher = await tempPath("current/Lane.app/Contents/Resources/bin/lane");
    const otherApp = await tempPath("other/Other.app");
    const otherExecutable = join(otherApp, "Contents/MacOS/Lane");
    const link = await tempPath("bin/lane");
    for (const path of [executable, launcher, otherExecutable]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "binary");
    }
    await mkdir(dirname(link), { recursive: true });
    await symlink(otherExecutable, link);
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: launcher,
      platform: "darwin",
      linkPaths: [link],
      readBundleIdentifier: async () => "com.example.other",
      runPrivileged: async () => {
        throw new Error("must not run");
      },
    });

    await expect(installer.install()).rejects.toThrow(
      `Another command already exists at ${link}`,
    );
  });

  it("does not replace a dangling symlink with unknown ownership", async () => {
    const executable = await tempPath("current/Lane.app/Contents/MacOS/Lane");
    const launcher = await tempPath("current/Lane.app/Contents/Resources/bin/lane");
    const missingExecutable = await tempPath("missing/Other.app/Contents/MacOS/Lane");
    const link = await tempPath("bin/lane");
    for (const path of [executable, launcher]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "binary");
    }
    await mkdir(dirname(link), { recursive: true });
    await symlink(missingExecutable, link);
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: launcher,
      platform: "darwin",
      linkPaths: [link],
      readBundleIdentifier: async () => "works.earendil.lane",
      runPrivileged: async () => {
        throw new Error("must not run");
      },
    });

    await expect(installer.install()).rejects.toThrow(
      `Another command already exists at ${link}`,
    );
  });

  it("installs and detects a Windows command launcher without elevation", async () => {
    const executable = await tempPath("Lane.exe");
    const nativeLauncher = await tempPath("resources/bin/lane-cli.exe");
    const command = await tempPath("WindowsApps/lane.cmd");
    await writeFile(executable, "binary");
    await mkdir(dirname(nativeLauncher), { recursive: true });
    await writeFile(nativeLauncher, "binary");
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: "unused-on-windows",
      platform: "win32",
      windowsCommandPath: command,
      windowsNativeLauncherPath: nativeLauncher,
    });

    expect(await installer.getState(false)).toMatchObject({
      enabled: false,
      installed: false,
      command: "lane",
    });
    expect(await installer.install()).toMatchObject({
      enabled: true,
      installed: true,
      command: "lane",
      path: command,
    });
    expect(await readFile(command, "utf8")).toContain(WINDOWS_CLI_MARKER);
    expect(await readFile(command, "utf8")).toContain(nativeLauncher);
    expect(await installer.getState(true)).toMatchObject({
      enabled: true,
      installed: true,
      path: command,
    });
  });

  it("refuses to replace an unrelated Windows command", async () => {
    const executable = await tempPath("Lane.exe");
    const nativeLauncher = await tempPath("resources/bin/lane-cli.exe");
    const command = await tempPath("WindowsApps/lane.cmd");
    await writeFile(executable, "binary");
    await mkdir(dirname(nativeLauncher), { recursive: true });
    await writeFile(nativeLauncher, "binary");
    await mkdir(dirname(command), { recursive: true });
    await writeFile(command, "@echo off\r\necho unrelated\r\n");
    const installer = new CliInstaller({
      executablePath: executable,
      launcherPath: "unused-on-windows",
      platform: "win32",
      windowsCommandPath: command,
      windowsNativeLauncherPath: nativeLauncher,
    });

    await expect(installer.install()).rejects.toThrow(
      `Another command already exists at ${command}`,
    );
  });
});
