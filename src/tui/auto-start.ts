import { spawn, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getConfig } from "../config/index.js";
import type { AUQConfig } from "../config/types.js";
import { getSessionDirectory } from "../session/utils.js";

const AUQ_COMMAND = "auq";
const TUI_RUNTIME_FILE = ".tui-runtime.json";

export interface TuiLaunchSpec {
  args: string[];
  command: string;
}

interface TuiRuntimeState {
  pid: number;
  startedAt: string;
}

type CommandAvailability = (command: string) => boolean;

let runtimeCleanupRegistered = false;

const LINUX_TERMINALS: TuiLaunchSpec[] = [
  { args: ["-e", AUQ_COMMAND], command: "x-terminal-emulator" },
  { args: ["--", AUQ_COMMAND], command: "gnome-terminal" },
  { args: ["-e", AUQ_COMMAND], command: "konsole" },
  { args: ["--command", AUQ_COMMAND], command: "xfce4-terminal" },
  { args: [AUQ_COMMAND], command: "kitty" },
  { args: ["-e", AUQ_COMMAND], command: "alacritty" },
  { args: ["-e", AUQ_COMMAND], command: "xterm" },
];

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function getTuiRuntimePath(): string {
  return join(getSessionDirectory(), TUI_RUNTIME_FILE);
}

async function removeTuiRuntimeFile(): Promise<void> {
  try {
    await unlink(getTuiRuntimePath());
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function unregisterTuiProcessSync(): void {
  try {
    const state = JSON.parse(
      readFileSync(getTuiRuntimePath(), "utf8"),
    ) as Partial<TuiRuntimeState>;
    // Do not remove a marker written by a newer TUI instance.
    if (state.pid !== process.pid) return;
    unlinkSync(getTuiRuntimePath());
  } catch {
    // Process exit cleanup must not prevent the process from exiting.
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function readTuiRuntimeState(): Promise<TuiRuntimeState | null> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(getTuiRuntimePath(), "utf8"));
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      await removeTuiRuntimeFile();
      return null;
    }
    throw error;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    await removeTuiRuntimeFile();
    return null;
  }

  return {
    pid: parsed.pid,
    startedAt:
      "startedAt" in parsed && typeof parsed.startedAt === "string"
        ? parsed.startedAt
        : "",
  };
}

export async function isTuiRunning(): Promise<boolean> {
  const state = await readTuiRuntimeState();
  if (!state) return false;
  if (isProcessRunning(state.pid)) return true;

  // A crash or force-kill skips exit cleanup, so remove stale state here.
  await removeTuiRuntimeFile();
  return false;
}

export async function registerTuiProcess(): Promise<void> {
  const sessionDirectory = getSessionDirectory();
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    getTuiRuntimePath(),
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    } satisfies TuiRuntimeState),
    "utf8",
  );

  if (!runtimeCleanupRegistered) {
    process.once("exit", unregisterTuiProcessSync);
    runtimeCleanupRegistered = true;
  }
}

export function unregisterTuiProcess(): void {
  unregisterTuiProcessSync();
}

export function getTuiLaunchSpec(
  platform: NodeJS.Platform = process.platform,
  isCommandAvailable: CommandAvailability = commandExists,
): TuiLaunchSpec {
  switch (platform) {
    case "win32":
      return {
        args: ["/d", "/c", "start", "", AUQ_COMMAND],
        command: "cmd.exe",
      };
    case "darwin":
      return {
        args: [
          "-e",
          `tell application "Terminal" to do script "${AUQ_COMMAND}"`,
        ],
        command: "osascript",
      };
    case "linux": {
      const terminal = LINUX_TERMINALS.find(({ command }) =>
        isCommandAvailable(command),
      );
      if (terminal) {
        return terminal;
      }
      throw new Error(
        "No supported Linux terminal emulator was found. Start AUQ manually with `auq`.",
      );
    }
    default:
      throw new Error(
        `Automatic AUQ startup is not supported on ${platform}. Start AUQ manually with \`auq\`.`,
      );
  }
}

export function getConfiguredTuiLaunchSpec(
  config: Pick<AUQConfig, "autoStartTuiArgs" | "autoStartTuiCommand">,
  platform: NodeJS.Platform = process.platform,
  isCommandAvailable: CommandAvailability = commandExists,
): TuiLaunchSpec {
  if (config.autoStartTuiCommand) {
    return {
      args: config.autoStartTuiArgs,
      command: config.autoStartTuiCommand,
    };
  }

  const platformSpec = getTuiLaunchSpec(platform, isCommandAvailable);
  return config.autoStartTuiArgs.length > 0
    ? { ...platformSpec, args: config.autoStartTuiArgs }
    : platformSpec;
}

function launchTui(spec: TuiLaunchSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    const handleError = (error: Error) => {
      reject(error);
    };

    child.once("error", handleError);
    child.once("spawn", () => {
      child.removeListener("error", handleError);
      child.unref();
      resolve();
    });
  });
}

let tuiStartPromise: Promise<void> | null = null;

export async function ensureTuiStarted(): Promise<void> {
  const config = getConfig();
  if (!config.autoStartTui) {
    return Promise.resolve();
  }

  // Share only an in-flight launch; the marker is checked for every request.
  if (tuiStartPromise) {
    return tuiStartPromise;
  }

  const startPromise = (async () => {
    if (await isTuiRunning()) return;

    const spec = getConfiguredTuiLaunchSpec(config);
    await launchTui(spec);
  })();

  tuiStartPromise = startPromise;
  try {
    await startPromise;
  } finally {
    if (tuiStartPromise === startPromise) tuiStartPromise = null;
  }
}
