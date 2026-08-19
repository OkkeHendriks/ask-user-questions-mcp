import { once } from "node:events";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getConfiguredTuiLaunchSpec,
  getTuiLaunchSpec,
  isTuiRunning,
  registerTuiProcess,
  unregisterTuiProcess,
} from "../auto-start.js";

describe("TUI auto-start launch specs", () => {
  const originalSessionDir = process.env.AUQ_SESSION_DIR;
  const testSessionDir = join(tmpdir(), "auq-auto-start-tests");

  beforeEach(async () => {
    process.env.AUQ_SESSION_DIR = testSessionDir;
    await fs.rm(testSessionDir, { force: true, recursive: true });
  });

  afterEach(async () => {
    if (originalSessionDir === undefined) {
      delete process.env.AUQ_SESSION_DIR;
    } else {
      process.env.AUQ_SESSION_DIR = originalSessionDir;
    }
    await fs.rm(testSessionDir, { force: true, recursive: true });
  });

  it("uses cmd.exe on Windows", () => {
    expect(getTuiLaunchSpec("win32")).toEqual({
      args: ["/d", "/c", "start", "", "auq"],
      command: "cmd.exe",
    });
  });

  it("uses Terminal.app on macOS", () => {
    expect(getTuiLaunchSpec("darwin")).toEqual({
      args: ["-e", 'tell application "Terminal" to do script "auq"'],
      command: "osascript",
    });
  });

  it("selects the first available Linux terminal", () => {
    expect(
      getTuiLaunchSpec("linux", (command) => command === "gnome-terminal"),
    ).toEqual({
      args: ["--", "auq"],
      command: "gnome-terminal",
    });
  });

  it("reports when Linux has no supported terminal", () => {
    expect(() => getTuiLaunchSpec("linux", () => false)).toThrow(
      "No supported Linux terminal emulator was found",
    );
  });

  it("uses configured command and arguments", () => {
    expect(
      getConfiguredTuiLaunchSpec(
        {
          autoStartTuiArgs: ["--", "auq"],
          autoStartTuiCommand: "custom-terminal",
        },
        "linux",
        () => false,
      ),
    ).toEqual({
      args: ["--", "auq"],
      command: "custom-terminal",
    });
  });

  it("detects a registered TUI process", async () => {
    expect(await isTuiRunning()).toBe(false);

    await registerTuiProcess();

    expect(await isTuiRunning()).toBe(true);
  });

  it("removes the marker when the TUI unregisters", async () => {
    await registerTuiProcess();
    expect(await isTuiRunning()).toBe(true);

    unregisterTuiProcess();

    expect(await isTuiRunning()).toBe(false);
  });

  it("removes an invalid TUI runtime marker", async () => {
    await fs.mkdir(testSessionDir, { recursive: true });
    const runtimePath = join(testSessionDir, ".tui-runtime.json");
    await fs.writeFile(runtimePath, JSON.stringify({ pid: 0 }), "utf8");

    expect(await isTuiRunning()).toBe(false);
    await expect(fs.access(runtimePath)).rejects.toThrow();
  });

  it("removes a marker after its process has exited", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const childPid = child.pid;
    expect(childPid).toBeDefined();

    child.kill();
    await once(child, "exit");

    await fs.mkdir(testSessionDir, { recursive: true });
    const runtimePath = join(testSessionDir, ".tui-runtime.json");
    await fs.writeFile(
      runtimePath,
      JSON.stringify({ pid: childPid, startedAt: new Date().toISOString() }),
      "utf8",
    );

    expect(await isTuiRunning()).toBe(false);
    await expect(fs.access(runtimePath)).rejects.toThrow();
  });
});
