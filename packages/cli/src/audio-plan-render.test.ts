import path from "node:path";
import os from "node:os";
import {
  access,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { renderAudioPlanPcm } from "./audio-plan-render.js";

describe("standalone PCM render publication", () => {
  it.each(["legacy", "ordinary-failure", "similar-error", "legacy-fails"])(
    "preserves file-backed graphs and limits compatibility retries: %s",
    async (mode) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "velocast-audio-option-"),
      );
      try {
        const helper = path.join(root, "ffmpeg-wrapper.cjs");
        const calls = path.join(root, "calls.jsonl");
        const outputPath = path.join(root, "result.f32");
        await writeFile(outputPath, "original-output");
        await writeFile(
          helper,
          `const fs=require('node:fs');
const args=process.argv.slice(2);
const mode=${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.includes('-/filter_complex')) {
  process.stderr.write(mode==='ordinary-failure' ? 'Error opening input file: missing.wav' : "Unrecognized option '/filter_complex'.\\n"+(mode==='similar-error' ? 'Error initializing complex filters' : 'Error splitting the argument list: Option not found'));
  process.exit(1);
}
if(mode==='legacy-fails') { process.stderr.write('legacy mix failed'); process.exit(2); }
const index=args.indexOf('-filter_complex_script');
if(index<0 || !fs.readFileSync(args[index+1],'utf8').includes('anullsrc')) process.exit(3);
fs.writeFileSync(args.at(-1),Buffer.alloc(16));`,
        );
        const pending = renderAudioPlanPcm(
          { sampleRate: 48000, durationSamples: 4, clips: [] },
          { outputPath, channelCount: 1, command: [process.execPath, helper] },
        );
        if (mode === "legacy") {
          await expect(pending).resolves.toMatchObject({ bytes: 16 });
          expect((await readFile(outputPath)).equals(Buffer.alloc(16))).toBe(
            true,
          );
        } else {
          await expect(pending).rejects.toThrow(
            mode === "legacy-fails"
              ? /legacy mix failed/
              : /Audio process exited/,
          );
          expect(await readFile(outputPath, "utf8")).toBe("original-output");
        }
        const attempts: string[][] = (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        expect(attempts).toHaveLength(mode.startsWith("legacy") ? 2 : 1);
        expect(attempts[0]).toContain("-/filter_complex");
        if (attempts.length === 2) {
          const first = attempts[0]!;
          const second = attempts[1]!;
          expect(second[second.indexOf("-filter_complex_script") + 1]).toBe(
            first[first.indexOf("-/filter_complex") + 1],
          );
        }
        expect(attempts.flat().some((arg) => arg.includes("anullsrc"))).toBe(
          false,
        );
        expect(
          (await readdir(root)).some((name) =>
            name.startsWith(".velocast-audio-"),
          ),
        ).toBe(false);
      } finally {
        expect(path.dirname(path.resolve(root))).toBe(
          path.resolve(os.tmpdir()),
        );
        expect(path.basename(root)).toMatch(/^velocast-audio-option-/);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("publishes only verified exact-length PCM and preserves an existing output on failure", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "velocast-audio-process-"),
    );
    try {
      const helper = path.join(root, "helper.cjs");
      await writeFile(
        helper,
        `const fs=require('node:fs');const out=process.argv.at(-1);fs.writeFileSync(out,Buffer.alloc(process.argv[2]==='ok'?16:3));if(process.argv[2]==='fail'){process.stderr.write('intentional child failure');process.exit(7);}`,
      );
      const outputPath = path.join(root, "result.f32");
      const plan = { sampleRate: 48000, durationSamples: 4, clips: [] };
      await writeFile(outputPath, "original-output");
      await expect(
        renderAudioPlanPcm(plan, {
          outputPath,
          channelCount: 1,
          command: [process.execPath, helper, "fail"],
        }),
      ).rejects.toThrow(/7/);
      expect(await readFile(outputPath, "utf8")).toBe("original-output");
      const result = await renderAudioPlanPcm(plan, {
        outputPath,
        channelCount: 1,
        command: [process.execPath, helper, "ok"],
      });
      expect(result.bytes).toBe(16);
      expect((await readFile(outputPath)).equals(Buffer.alloc(16))).toBe(true);
      expect(
        (await readdir(root)).some((name) =>
          name.startsWith(".velocast-audio-"),
        ),
      ).toBe(false);
    } finally {
      expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^velocast-audio-process-/);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects short/non-finite PCM and snapshots mutable caller plan/options", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "velocast-audio-process-"),
    );
    try {
      const helper = path.join(root, "helper.cjs");
      await writeFile(
        helper,
        `const fs=require('node:fs');const b=Buffer.alloc(process.argv[2]==='short'?3:16);if(process.argv[2]==='nan')b.writeFloatLE(NaN,0);fs.writeFileSync(process.argv.at(-1),b);`,
      );
      const outputPath = path.join(root, "result.f32");
      await writeFile(outputPath, "unchanged");
      const plan = { sampleRate: 48000, durationSamples: 4, clips: [] };
      for (const mode of ["short", "nan"]) {
        await expect(
          renderAudioPlanPcm(plan, {
            outputPath,
            channelCount: 1,
            command: [process.execPath, helper, mode],
          }),
        ).rejects.toThrow(/PCM/);
        expect(await readFile(outputPath, "utf8")).toBe("unchanged");
      }
      const options = {
        outputPath,
        channelCount: 1 as 1 | 2,
        command: [process.execPath, helper, "ok"],
      };
      const pending = renderAudioPlanPcm(plan, options);
      plan.durationSamples = 100;
      options.channelCount = 2;
      options.command[2] = "short";
      expect((await pending).bytes).toBe(16);
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith(".velocast-audio-"),
        ),
      ).toEqual([]);
    } finally {
      expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^velocast-audio-process-/);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels a running child, waits for termination, and removes all private partial files", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "velocast-audio-process-"),
    );
    try {
      const helper = path.join(root, "helper.cjs");
      const ready = path.join(root, "ready");
      await writeFile(
        helper,
        `const fs=require('node:fs');fs.writeFileSync(process.argv.at(-1),'partial');fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000);`,
      );
      const outputPath = path.join(root, "result.f32");
      await writeFile(outputPath, "original");
      const controller = new AbortController();
      const pending = renderAudioPlanPcm(
        { sampleRate: 48000, durationSamples: 4, clips: [] },
        {
          outputPath,
          channelCount: 1,
          command: [process.execPath, helper, ready],
          signal: controller.signal,
        },
      );
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          await access(ready).then(
            () => true,
            () => false,
          )
        )
          break;
        await delay(10);
      }
      await access(ready);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(await readFile(outputPath, "utf8")).toBe("original");
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith(".velocast-audio-"),
        ),
      ).toEqual([]);
      await expect(
        renderAudioPlanPcm(
          { sampleRate: 48000, durationSamples: 4, clips: [] },
          { outputPath, channelCount: 1, signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^velocast-audio-process-/);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never publishes over a source alias", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "velocast-audio-process-"),
    );
    try {
      const source = path.join(root, "source.wav");
      const outputPath = path.join(root, "alias.f32");
      await writeFile(source, "original-source");
      await link(source, outputPath);
      await expect(
        renderAudioPlanPcm(
          {
            sampleRate: 48000,
            durationSamples: 4,
            clips: [
              {
                source,
                startSample: 0,
                sourceStartSample: 0,
                durationSamples: 4,
                gain: 1,
              },
            ],
          },
          {
            outputPath,
            channelCount: 1,
            sourceChannelCounts: new Map([[source, 1]]),
          },
        ),
      ).rejects.toThrow(/source file alias/);
      expect(await readFile(source, "utf8")).toBe("original-source");
    } finally {
      expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^velocast-audio-process-/);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("snapshots complete mono/stereo source metadata before asynchronous rendering", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "velocast-audio-layout-"),
    );
    try {
      const source = path.join(root, "voice.wav"),
        outputPath = path.join(root, "out.f32");
      await writeFile(source, "source");
      const channels = new Map([[source, 1 as 1 | 2]]);
      const helper = path.join(root, "helper.cjs"),
        marker = path.join(root, "received-argv.json");
      await writeFile(
        helper,
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv)+fs.readFileSync(process.argv[process.argv.indexOf("-/filter_complex")+1],"utf8"));fs.writeFileSync(process.argv.at(-1),Buffer.alloc(16))`,
      );
      const pending = renderAudioPlanPcm(
        {
          sampleRate: 48000,
          durationSamples: 2,
          clips: [
            {
              source,
              startSample: 0,
              sourceStartSample: 0,
              durationSamples: 2,
              gain: 1,
            },
          ],
        },
        {
          outputPath,
          channelCount: 2,
          sourceChannelCounts: channels,
          command: [process.execPath, helper],
        },
      );
      channels.set(source, 2);
      await expect(pending).resolves.toMatchObject({ bytes: 16 });
      expect(await readFile(marker, "utf8")).toContain(
        "pan=stereo|c0=c0|c1=c0",
      );
      const plan = {
        sampleRate: 48000,
        durationSamples: 2,
        clips: [
          {
            source,
            startSample: 0,
            sourceStartSample: 0,
            durationSamples: 2,
            gain: 1,
          },
        ],
      };
      await expect(
        renderAudioPlanPcm(plan, {
          outputPath: path.join(root, "invalid.f32"),
          channelCount: 2,
          sourceChannelCounts: new Map([[source, 3 as unknown as 1]]),
        }),
      ).rejects.toThrow(/1 or 2/);
      await expect(
        renderAudioPlanPcm(plan, {
          outputPath: path.join(root, "missing.f32"),
          channelCount: 2,
          sourceChannelCounts: new Map(),
        }),
      ).rejects.toThrow(/missing/);
      if (process.platform === "win32")
        await expect(
          renderAudioPlanPcm(plan, {
            outputPath: path.join(root, "duplicate.f32"),
            channelCount: 2,
            sourceChannelCounts: new Map([
              [source, 1],
              [source.toUpperCase(), 2],
            ]),
          }),
        ).rejects.toThrow(/inconsistent/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
