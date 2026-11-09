---
name: velocast
description: Create, edit, animate, inspect, or render videos with Velocast. Use for product intros, narrated explainers, portrait captions, multi-scene compositions, reusable motion graphics, or resuming human edits in a Velocast project.
---

# Velocast video production

1. Inspect the existing project's source, scripts and `velocast capabilities --json`.
   For a new project, read [setup](references/setup.md). Establish the brief:
   dimensions, fps, duration, supplied assets, copy and desired output. Resolve
   routine choices from the brief and project; ask only for missing creative inputs.
2. Author ordinary React source. Read [authoring](references/authoring.md) for
   frame timing, scenes and reusable graphics; read [media and captions](references/media.md)
   when placing footage, sound, narration or timed text. Keep assets local.
3. Build, inspect exact frames at starts, transitions, caption boundaries and the
   final frame, then refine. Open the PNGs and preview motion with sound. Use
   [iteration and recovery](references/workflow.md) for Studio/MCP, external source
   edits, failed builds, missing assets and cancellation.
4. Render the requested deliverable, run `velocast verify` with explicit expected
   frames, fps, dimensions and audio, and inspect the actual output. Deliver its
   path and state any unverified visual/audio checks or runtime limitations.

Done means the requested file exists and its content, timing and sound have been
checked. A successful build or metadata report alone does not establish quality.
