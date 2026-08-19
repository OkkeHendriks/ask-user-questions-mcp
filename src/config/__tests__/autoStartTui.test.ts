import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../defaults.js";
import { AUQConfigSchema } from "../types.js";

describe("autoStartTui config", () => {
  it("is disabled by default", () => {
    expect(DEFAULT_CONFIG.autoStartTui).toBe(false);
    expect(DEFAULT_CONFIG.autoStartTuiArgs).toEqual([]);
    expect(AUQConfigSchema.parse({}).autoStartTui).toBe(false);
  });

  it("accepts a boolean value", () => {
    expect(AUQConfigSchema.parse({ autoStartTui: true }).autoStartTui).toBe(
      true,
    );
  });

  it("rejects non-boolean values", () => {
    expect(() => AUQConfigSchema.parse({ autoStartTui: "true" })).toThrow();
  });

  it("accepts command and argument overrides", () => {
    const config = AUQConfigSchema.parse({
      autoStartTuiArgs: ["--", "auq"],
      autoStartTuiCommand: "gnome-terminal",
    });

    expect(config.autoStartTuiCommand).toBe("gnome-terminal");
    expect(config.autoStartTuiArgs).toEqual(["--", "auq"]);
  });
});
