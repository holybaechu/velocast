import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { writeJsonOutput } from "./atomic-json-output.js";

export interface TimedTextCue {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TimedTextDocument {
  schemaVersion: 1;
  sourceFormat: "srt" | "vtt" | "json";
  cues: TimedTextCue[];
}

function timestampSeconds(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const match = /^(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d{1,3})?)$/.exec(normalized);
  if (!match) throw new Error(`transcript.invalid_timestamp: ${value}`);
  const seconds =
    Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (!Number.isFinite(seconds))
    throw new Error(`transcript.invalid_timestamp: ${value}`);
  return seconds;
}

export function validateTimedTextCues(value: unknown): TimedTextCue[] {
  if (!Array.isArray(value))
    throw new Error("transcript.invalid_json: expected an array of cues");
  let previousStart = -1;
  return value.map((candidate, index) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    )
      throw new Error(`transcript.invalid_cue: cue ${index} must be an object`);
    const record = candidate as Record<string, unknown>;
    const startSeconds = record.startSeconds;
    const endSeconds = record.endSeconds;
    const text = record.text;
    const id = record.id ?? String(index + 1);
    if (
      typeof startSeconds !== "number" ||
      typeof endSeconds !== "number" ||
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      endSeconds <= startSeconds
    )
      throw new Error(
        `transcript.invalid_cue: cue ${index} requires finite 0 <= startSeconds < endSeconds`,
      );
    if (startSeconds < previousStart)
      throw new Error(
        `transcript.invalid_order: cue ${index} starts before the previous cue`,
      );
    if (typeof text !== "string" || !text.trim())
      throw new Error(`transcript.invalid_cue: cue ${index} text is required`);
    if (typeof id !== "string" || !id.trim())
      throw new Error(`transcript.invalid_cue: cue ${index} id is required`);
    previousStart = startSeconds;
    return { id: id.trim(), startSeconds, endSeconds, text: text.trim() };
  });
}

function parseCaptionText(
  contents: string,
  sourceFormat: "srt" | "vtt",
): TimedTextCue[] {
  const normalized = contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const body =
    sourceFormat === "vtt"
      ? normalized.replace(/^WEBVTT[^\n]*\n+/, "")
      : normalized;
  const blocks = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const cues: TimedTextCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (
      sourceFormat === "vtt" &&
      /^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] ?? "")
    )
      continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0)
      throw new Error(
        `transcript.invalid_cue: missing --> in block ${cues.length + 1}`,
      );
    const [startText, rawEnd] = lines[timingIndex]!.split(/\s+-->\s+/, 2);
    const endText = rawEnd?.split(/\s+/, 1)[0];
    if (!startText || !endText)
      throw new Error(
        `transcript.invalid_cue: malformed timing in block ${cues.length + 1}`,
      );
    const text = lines
      .slice(timingIndex + 1)
      .join("\n")
      .trim();
    const id =
      timingIndex > 0
        ? lines.slice(0, timingIndex).join(" ").trim()
        : String(cues.length + 1);
    cues.push({
      id: id || String(cues.length + 1),
      startSeconds: timestampSeconds(startText),
      endSeconds: timestampSeconds(endText),
      text,
    });
  }
  return validateTimedTextCues(cues);
}

export function importTimedText(
  contents: string,
  format: "srt" | "vtt" | "json",
): TimedTextDocument {
  let cues: TimedTextCue[];
  if (format === "json") {
    const value = JSON.parse(contents) as unknown;
    cues = validateTimedTextCues(
      typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "cues" in value
        ? (value as { cues: unknown }).cues
        : value,
    );
  } else cues = parseCaptionText(contents, format);
  return { schemaVersion: 1, sourceFormat: format, cues };
}

export interface TranscriptImportOptions {
  output: string;
  format?: "srt" | "vtt" | "json";
  json?: boolean;
  overwrite?: boolean;
  write?: (text: string) => void;
}

export async function importTranscriptCommand(
  input: string,
  options: TranscriptImportOptions,
): Promise<TimedTextDocument> {
  const extension = extname(input).toLowerCase();
  const format =
    options.format ??
    (extension === ".srt"
      ? "srt"
      : extension === ".vtt"
        ? "vtt"
        : extension === ".json"
          ? "json"
          : undefined);
  if (!format)
    throw new Error(
      "transcript.format_required: use .srt, .vtt, .json, or --format",
    );
  const document = importTimedText(
    await readFile(resolve(input), "utf8"),
    format,
  );
  const output = resolve(options.output);
  await writeJsonOutput(
    output,
    `${JSON.stringify(document, null, 2)}\n`,
    options.overwrite === true,
  );
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  write(
    options.json
      ? `${JSON.stringify({ output, ...document }, null, 2)}\n`
      : `Imported ${document.cues.length} timed cues: ${output}\n`,
  );
  return document;
}
