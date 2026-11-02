import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import {
  isVideoProject,
  parseVideoProject,
  type ProjectAsset,
} from "@velocast/core";
import type { MediaProbe } from "../media/media-runtime.js";
import {
  StudioInputsError,
  type SavedStudioInputs,
  type StudioInputsStore,
} from "./studio-inputs.js";

export const MAX_STUDIO_ASSET_BYTES = 256 * 1024 * 1024;
export const STUDIO_ASSET_EXTENSIONS = {
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"],
  video: [".mp4", ".webm", ".mov", ".mkv"],
  audio: [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac"],
} as const;

async function directory(path: string) {
  await mkdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new StudioInputsError(
      400,
      "studio.asset_directory",
      "Media folders must be regular directories, not symbolic links",
    );
}

/** Owns the copied file until its guarded source edit commits. */
export async function importStudioAsset(
  request: IncomingMessage,
  query: URLSearchParams,
  store: StudioInputsStore,
  signal: AbortSignal,
  probe: (path: string, signal: AbortSignal) => Promise<MediaProbe>,
): Promise<SavedStudioInputs> {
  const before = await store.read();
  if (!before.enabled || !isVideoProject(before.inputProps))
    throw new StudioInputsError(
      400,
      "studio.assets_disabled",
      "Media import requires a saved VideoProject",
    );
  if (before.revision !== query.get("expectedRevision"))
    throw new StudioInputsError(
      409,
      "studio.inputs_conflict",
      "Saved project changed; reload before importing media",
    );
  const project = parseVideoProject(before.inputProps);
  const name = query.get("name") ?? "";
  if (
    !name ||
    name.length > 200 ||
    name !== basename(name) ||
    /[\\/]/.test(name) ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32)
  )
    throw new StudioInputsError(
      400,
      "studio.asset_name",
      "Supply a filename without directory segments",
    );
  const extension = extname(name).toLowerCase();
  const kind = (
    Object.keys(STUDIO_ASSET_EXTENSIONS) as ProjectAsset["kind"][]
  ).find((kind) =>
    (STUDIO_ASSET_EXTENSIONS[kind] as readonly string[]).includes(extension),
  );
  if (!kind)
    throw new StudioInputsError(
      400,
      "studio.asset_type",
      "Unsupported media extension; inspect /api/capabilities for accepted formats",
    );
  if (Number(request.headers["content-length"]) > MAX_STUDIO_ASSET_BYTES)
    throw new StudioInputsError(
      413,
      "studio.asset_limit",
      "Media import exceeds 256 MiB",
    );
  const publicPath = join(dirname(before.path), "public");
  const assetsPath = join(publicPath, "assets");
  await directory(publicPath);
  await directory(assetsPath);
  const id = randomUUID();
  const stem =
    name
      .slice(0, -extension.length)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 80) || "media";
  const filename = `${stem}-${id}${extension}`;
  const path = join(assetsPath, filename);
  const file = await open(path, "wx");
  let committed = false;
  try {
    let bytes = 0;
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > MAX_STUDIO_ASSET_BYTES) {
          request.resume();
          throw new StudioInputsError(
            413,
            "studio.asset_limit",
            "Media import exceeds 256 MiB",
          );
        }
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    if (bytes === 0)
      throw new StudioInputsError(
        400,
        "studio.asset_empty",
        "Choose a nonempty media file",
      );
    const asset: ProjectAsset = { id, name, kind, src: `assets/${filename}` };
    if (kind !== "image") {
      const media = await probe(path, signal);
      if (
        (kind === "video" && !media.video) ||
        (kind === "audio" && !media.audio)
      )
        throw new StudioInputsError(
          400,
          "studio.asset_track",
          `The file does not contain a usable ${kind} track`,
        );
      asset.durationSeconds =
        kind === "audio"
          ? media.audio!.duration
          : (media.video!.duration ?? media.duration);
      if (kind === "video") {
        asset.hasAudio = !!media.audio;
        asset.width = media.video!.width;
        asset.height = media.video!.height;
      }
    }
    signal.throwIfAborted();
    project.assets.push(asset);
    const saved = await store.save(before.revision, project, signal);
    committed = true;
    return saved;
  } finally {
    if (!committed) await rm(path, { force: true });
  }
}
