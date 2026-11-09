import { expect, it, vi } from "vitest";
import { runCli } from "../cli.js";

it("discovers executable commands, options and constraints without loading a project or runtime", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const loadConfigFromPath = vi.fn();
  try {
    await runCli(["node", "velocast", "capabilities", "--json"], {
      loadConfigFromPath,
    });
    const report = JSON.parse(
      write.mock.calls.map(([value]) => String(value)).join(""),
    );
    expect(report.apiVersion).toBe(1);
    expect(report.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "frame",
          options: expect.arrayContaining([
            expect.objectContaining({ flag: "--frame <number>" }),
          ]),
        }),
        expect.objectContaining({ name: "verify" }),
        expect.objectContaining({ name: "studio" }),
      ]),
    );
    expect(report.authoring.timing).toEqual({
      firstFrame: 0,
      rangeEnd: "exclusive",
      audioUnit: "sample frames",
    });
    expect(report.studio.source).toContain(
      "source adapter studio is unsupported",
    );
    expect(loadConfigFromPath).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
});

it("returns machine-readable errors for setup failures and unknown operations", async () => {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  try {
    await expect(
      runCli(["node", "velocast", "not-a-command", "--json"]),
    ).rejects.toThrow("cli.unknown_command");
    expect(
      JSON.parse(write.mock.calls.map(([value]) => String(value)).join("")),
    ).toMatchObject({
      status: "failure",
      error: { code: "cli.unknown_command" },
    });
    write.mockClear();
    await expect(
      runCli(["node", "velocast", "studio", "--json"], {
        loadConfigFromPath: async () => {
          throw new Error("config.missing: cannot find config");
        },
      }),
    ).rejects.toThrow("config.missing");
    expect(
      JSON.parse(write.mock.calls.map(([value]) => String(value)).join("")),
    ).toMatchObject({
      status: "failure",
      operation: "studio",
      error: { code: "config.missing" },
    });
  } finally {
    write.mockRestore();
  }
});
