export const VELOCAST_AGENT_SKILL = `---
name: velocast
description: Create, inspect, repair, and render code-authored Velocast compositions when exact frames, motion, lyrics timing, or local media analysis matter.
---

# Velocast video workflow

Work from the project directory containing \`velocast.config.*\`. Treat built output as the inspectable artifact and source files as the editable artifact.

## Create and inspect

1. Read the registered composition and its frame-derived source. Keep animation state derived from the requested frame rather than timers or playback history.
2. Build the project. Run \`velocast compositions --json\`, then inspect exact boundary and transition frames with \`velocast frame\` or \`velocast check\`.
3. Put assertions that matter to the requested design in a checked-in JSON file. Use selectors for visible state, composition bounds, clipping, contrast, and motion endpoints. Read the check report's limits before treating it as visual approval.

## Fix and verify

Trace each issue to authored layout, timing, or resources. Rebuild, rerun the same exact frames and assertions, and inspect snapshots when computed checks are insufficient. A passing automated report does not assess typography taste, image composition, gradients, canvas pixels, or animation quality.

## Lyrics and music

Import supplied SRT, VTT, or timestamp JSON with \`velocast transcript import\`. Preserve the supplied words and timing; never invent missing lyrics or claim transcription occurred. Pass \`--overwrite\` when refreshing a generated project's existing \`src/lyrics.json\`; replacement is atomic.

Run \`velocast analyze-audio\` for bounded local RMS energy and onset candidates. Treat its confidence as a heuristic. Verify candidates while listening before using them as beats, downbeats, meter, or lyric timing.

## Render

Render a short half-open range around changed transitions before the full composition. Use \`--input-props-file\` when inputs belong outside source. Confirm the output report identifies the expected composition, source version, frame or range, and output path.

For investigation of another application or website, use the external agent's browser/DevTools access to collect concrete design facts, then encode them in the local composition. Velocast owns deterministic inspect, preview, and render behavior; it does not infer another app's design.
`;
