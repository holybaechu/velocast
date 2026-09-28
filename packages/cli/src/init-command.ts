import {
  lstat,
  mkdir,
  mkdtemp,
  copyFile,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  assertNonEmptyString,
  getInvocationCwd,
  resolvePathFrom,
  type InvocationPathOptions,
} from "./paths.js";
import {
  REACT_STARTER_COMPOSITION_ID,
  REACT_STARTER_TEMPLATE_VERSION,
  reactStaticFiles,
} from "./templates/react-static.js";
import {
  createLyricsStarterFiles,
  LYRICS_STARTER_COMPOSITION_ID,
  LYRICS_STARTER_TEMPLATE_VERSION,
  lyricsStarterFiles,
} from "./templates/lyrics.js";
import { analyzeMusic } from "./music-analysis.js";
import { importTimedText } from "./timestamps.js";

export type ProjectTemplate = "react-static" | "lyrics";

export interface InitProjectResult {
  directory: string;
  template: ProjectTemplate;
  templateVersion: number;
  compositionId: string;
  dependenciesInstalled: false;
  files: string[];
  suppliedMedia?: {
    audio: string;
    lyrics: string | null;
    cueCount: number;
    durationFrames: number;
    analysis: string;
  };
}

export interface InitCommandOptions {
  json?: boolean;
  template?: ProjectTemplate;
  audio?: string;
  lyrics?: string;
}
export interface InitCommandDependencies {
  pathOptions?: InvocationPathOptions;
  write?: (text: string) => void;
}

export interface CreateProjectOptions extends InvocationPathOptions {
  template?: ProjectTemplate;
  audio?: string;
  lyrics?: string;
}

interface PreparedLyricsTemplate {
  files: Readonly<Record<string, string>>;
  audioSource?: string;
  audioFileName?: string;
  suppliedMedia?: InitProjectResult["suppliedMedia"];
}

async function prepareLyricsTemplate(
  options: CreateProjectOptions,
): Promise<PreparedLyricsTemplate> {
  if (!options.audio && options.lyrics)
    throw new Error(
      "init.lyrics_require_audio: --lyrics requires --audio so cue bounds can be verified",
    );
  if (!options.audio) return { files: lyricsStarterFiles };
  const cwd = getInvocationCwd(options);
  const audioSource = resolvePathFrom(cwd, options.audio);
  const extension = extname(audioSource).toLowerCase();
  if (!/[.](wav|mp3|m4a|aac|ogg|opus)$/.test(extension))
    throw new Error(
      "init.unsupported_audio: use wav, mp3, m4a, aac, ogg, or opus",
    );
  const audioStat = await lstat(audioSource);
  if (!audioStat.isFile() || audioStat.isSymbolicLink())
    throw new Error("init.invalid_audio: --audio must be a regular local file");
  if (audioStat.size > 256 * 1024 * 1024)
    throw new Error(
      "init.audio_too_large: supplied audio exceeds the 256 MiB snapshot limit",
    );
  const analysis = await analyzeMusic(audioSource, {
  });
  const durationSeconds = analysis.decoded.sourceDurationSeconds;
  if (durationSeconds === null || analysis.decoded.truncated)
    throw new Error(
      "init.audio_duration_unverified: The media runtime must report a source duration within the 900-second analysis bound",
    );
  const durationFrames = Math.max(1, Math.ceil(durationSeconds * 60));
  let timedText = importTimedText("[]", "json");
  let lyricsPath: string | null = null;
  if (options.lyrics) {
    lyricsPath = resolvePathFrom(cwd, options.lyrics);
    const formatExtension = extname(lyricsPath).toLowerCase();
    const format =
      formatExtension === ".srt"
        ? "srt"
        : formatExtension === ".vtt"
          ? "vtt"
          : formatExtension === ".json"
            ? "json"
            : undefined;
    if (!format)
      throw new Error(
        "init.unsupported_lyrics: --lyrics must be .srt, .vtt, or .json",
      );
    timedText = importTimedText(await readFile(lyricsPath, "utf8"), format);
    const outside = timedText.cues.find(
      (cue) => cue.endSeconds > durationSeconds + 0.001,
    );
    if (outside)
      throw new Error(
        `init.lyrics_outside_audio: cue ${outside.id} ends at ${outside.endSeconds}s after audio duration ${durationSeconds}s`,
      );
  }
  const audioFileName = `audio${extension}`;
  const files = {
    ...createLyricsStarterFiles({
      durationFrames,
      audioFileName,
      musicAnalysis: { ...analysis, source: `public/${audioFileName}` },
      importedCueCount: timedText.cues.length,
    }),
    "src/lyrics.json": `${JSON.stringify(timedText, null, 2)}\n`,
  };
  return {
    files: Object.freeze(files),
    audioSource,
    audioFileName,
    suppliedMedia: {
      audio: audioSource,
      lyrics: lyricsPath,
      cueCount: timedText.cues.length,
      durationFrames,
      analysis: "src/music-analysis.json",
    },
  };
}

async function assertNoSymlinks(path: string): Promise<void> {
  const absolute = resolve(path),
    prefix = parse(absolute).root;
  let current = prefix;
  for (const part of absolute.slice(prefix.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(
          `init.invalid_target: symlink/junction targets are not supported: ${current}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function emptyTargetIdentity(
  target: string,
): Promise<string | undefined> {
  let stat;
  try {
    stat = await lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(
      `init.invalid_target: expected a missing or empty directory: ${target}`,
    );
  if ((await readdir(target)).length)
    throw new Error(
      `init.target_not_empty: refusing to overwrite files in ${target}`,
    );
  return `${stat.dev}:${stat.ino}`;
}

function assertOwnedStage(parent: string, stage: string): void {
  const relativeStage = relative(parent, resolve(stage));
  if (
    dirname(resolve(stage)) !== resolve(parent) ||
    relativeStage.startsWith("..") ||
    !basename(stage).startsWith(".velocast-init-")
  )
    throw new Error(
      "init.cleanup_scope: staging path escaped its owned parent",
    );
}

export async function createReactProject(
  directory: string,
  options: CreateProjectOptions = {},
): Promise<InitProjectResult> {
  assertNonEmptyString(
    directory,
    "init.invalid_target: directory must be a non-empty path",
  );
  const target = resolvePathFrom(getInvocationCwd(options), directory);
  if (target === parse(target).root)
    throw new Error(
      "init.invalid_target: a filesystem root is not a project directory",
    );
  await assertNoSymlinks(target);
  const identity = await emptyTargetIdentity(target);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const template = options.template ?? "react-static";
  if (template !== "lyrics" && (options.audio || options.lyrics))
    throw new Error(
      "init.media_requires_lyrics_template: --audio and --lyrics require --template lyrics",
    );
  const preparedLyrics =
    template === "lyrics" ? await prepareLyricsTemplate(options) : undefined;
  const selected =
    template === "react-static"
      ? {
          files: reactStaticFiles,
          version: REACT_STARTER_TEMPLATE_VERSION,
          compositionId: REACT_STARTER_COMPOSITION_ID,
        }
      : template === "lyrics"
        ? {
            files: preparedLyrics!.files,
            version: LYRICS_STARTER_TEMPLATE_VERSION,
            compositionId: LYRICS_STARTER_COMPOSITION_ID,
          }
        : undefined;
  if (!selected) throw new Error(`init.unknown_template: ${String(template)}`);
  let stage: string | undefined = await mkdtemp(
    join(parent, ".velocast-init-"),
  );
  let removedEmptyTarget = false;
  try {
    for (const [name, contents] of Object.entries(selected.files)) {
      const file = join(stage, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, { flag: "wx" });
    }
    if (preparedLyrics?.audioSource && preparedLyrics.audioFileName) {
      await mkdir(join(stage, "public"), { recursive: true });
      await copyFile(
        preparedLyrics.audioSource,
        join(stage, "public", preparedLyrics.audioFileName),
      );
    }
    await assertNoSymlinks(target);
    const current = await emptyTargetIdentity(target);
    if (current !== identity)
      throw new Error(
        `init.target_changed: destination changed during creation: ${target}`,
      );
    if (identity !== undefined) {
      // Non-recursive removal refuses any concurrently added user files.
      await rmdir(target);
      removedEmptyTarget = true;
    }
    assertOwnedStage(parent, stage);
    if (dirname(resolve(target)) !== resolve(parent))
      throw new Error(
        "init.invalid_target: destination escaped its selected parent",
      );
    await rename(stage, target);
    stage = undefined;
    return {
      directory: target,
      template,
      templateVersion: selected.version,
      compositionId: selected.compositionId,
      dependenciesInstalled: false,
      files: [
        ...Object.keys(selected.files),
        ...(preparedLyrics?.audioFileName
          ? [`public/${preparedLyrics.audioFileName}`]
          : []),
      ].sort(),
      ...(preparedLyrics?.suppliedMedia
        ? { suppliedMedia: preparedLyrics.suppliedMedia }
        : {}),
    };
  } catch (error) {
    if (removedEmptyTarget) {
      try {
        await mkdir(target);
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST")
          throw new AggregateError(
            [error, restoreError],
            "init.failed: creation failed and the empty target could not be restored",
            { cause: restoreError },
          );
      }
    }
    throw error;
  } finally {
    if (stage) {
      assertOwnedStage(parent, stage);
      await rm(stage, { recursive: true, force: true });
    }
  }
}

export async function initCommand(
  directory: string,
  options: InitCommandOptions = {},
  dependencies: InitCommandDependencies = {},
): Promise<InitProjectResult> {
  const result = await createReactProject(directory, {
    ...dependencies.pathOptions,
    template: options.template,
    audio: options.audio,
    lyrics: options.lyrics,
  });
  const write =
    dependencies.write ?? ((text: string) => process.stdout.write(text));
  write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Created React project: ${result.directory}\nNo dependencies were installed.\nInside that directory, run:\n  npm install\n  npm run build\n  npm run render\n`,
  );
  return result;
}
