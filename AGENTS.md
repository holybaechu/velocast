# Agent guidance

Velocast is a video-rendering project with TypeScript authoring, CLI, and preview
packages, a Rust renderer, and an Electron media host. Optimize for correct frames
and audio timing, reliable resource cleanup, and simple, maintainable code.

These requirements apply to all work in this repository.

## Keep changes small

- Make the smallest coherent change that fulfills the request. Keep unrelated
  cleanup separate.
- Prefer existing configuration options and direct code. Keep one-off logic local;
  introduce abstractions or dependencies only when the current task needs them.
- Build for the environments this repository actually supports. Add portability,
  fallback behavior, and configurability only for a concrete requirement.
- Keep tooling lightweight. Add automation or process only when requested or
  needed to solve a recurring problem.

## Contracts and rendering behavior

- Shared generated wire types come from `contracts/renderer-protocol.json` through
  `scripts/contracts/generate-renderer-contracts.mjs`. Change the source and regenerate with
  `pnpm contracts:generate`; keep generated files aligned with it.
- Preserve exact frame identity and ordering, frame/range bounds, input-props
  snapshots, and audio sample timing across authoring, preview, and export.
- Honor explicit codec, container, and acceleration choices. Report unsupported
  requests and the actual capture and encoding behavior accurately.
- Keep worker shutdown, cancellation, and resource ownership explicit. Finish or
  terminate owned work before cleanup or publication, and preserve previous output
  when a render fails before publication.

## Documentation

- Add or update documentation when requested or needed to explain changed public
  usage or maintenance. Keep it short and actionable; do not recreate removed
  guides merely for completeness.
- Document each fact once. Check links when moving content, and keep prerequisites
  and recovery instructions with the affected commands.
- Keep plans, questionnaires, progress reports, research reports, and session notes
  outside the repository. Retain only durable project inputs and requested
  deliverables.

## Validation

- Run focused existing checks for the affected behavior. Use `pnpm check:fast` for
  broader feature validation when the scope warrants it; it does not replace
  native renderer or real output checks. Documentation-only edits need a diff
  review.
- For shared wire-contract changes, run `pnpm contracts:check`,
  `pnpm test:policy`, and the CLI wire-conformance tests. Verify actual serialized
  data across TypeScript and Rust.
- For native renderer changes, run the relevant renderer tests, including
  `cargo test -p velocast-renderer` when appropriate. Capture, encoding, and audio
  changes also need representative output checks on the affected platform.
- Prioritize regressions in frame identity, timestamps, audio synchronization,
  protocol compatibility, worker shutdown, cancellation, and output publication.
  Add tests for concrete regressions or changed public behavior; reuse fixtures
  and isolate machine interactions where practical.
- Prefer representative behavior checks over exhaustive combinations or
  assertions about implementation details. Coverage targets and a new test for
  every change are unnecessary.
- Performance claims need comparable inputs, platform, codec/bitrate, worker count,
  and end-to-end timing, with output correctness checked. Distinguish unit tests,
  actual rendered-output checks, and benchmarks. Report failed, blocked, skipped,
  or unrun checks and relevant gaps explicitly.

## Repository files and temporary work

- Write files in the repository only when they are maintained project inputs or
  required deliverables: source, tests, fixtures, configuration, documentation, or
  intentionally versioned assets. An ignore rule does not make a directory
  appropriate for temporary work.
- Create a unique, task-specific directory under the operating system's temporary
  directory, outside every repository and worktree, for scratch scripts, logs,
  benchmark outputs, generated reports, media, archives, and PR body files. Direct
  temporary build outputs and caches there when configurable.
- Keep durable findings in the relevant maintained project file; leave raw
  execution evidence and intermediate files in the temporary directory.
- Delete task-created temporary files and directories when they are no longer
  needed and before finishing, including after failures. Retain explicitly
  requested artifacts at the agreed location and remove their intermediates.
- Before recursive cleanup, resolve the absolute path, verify it is outside the
  repository and belongs to the current task, and stop processes using it. Delete
  only task-owned paths; preserve pre-existing and unrelated files.
- Before committing, inspect the staged diff and untracked files. Include only
  intentional repository changes and confirm temporary work has been cleaned up.

## Commit messages and PR titles

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`<type>[optional scope][!]: <description>`.

- Use `feat` for new behavior, `fix` for corrections, and `docs`, `refactor`,
  `perf`, `test`, `build`, `ci`, `style`, `chore`, or `revert` as appropriate.
- Write a short, imperative description beginning with a lowercase word, without
  a trailing period. Add a scope only when it clarifies the affected area.
- Mark breaking changes with `!` and explain the impact and required migration in
  a `BREAKING CHANGE:` footer.
- Example: `fix(renderer): reap workers before cleanup`.
- Use the same convention for merge and squash commit subjects.

## Branches and PR bodies

- New work branches use `<type>/<short-kebab-case-description>`, using the types
  above and lowercase letters, digits, and hyphens in the description. Start with
  the type directly; omit namespace prefixes, including `codex/`.
  Example: `fix/worker-cleanup`.
- Keep each PR focused on one coherent change. Its title follows the commit format
  above, and its title and description must match the final diff.
- Follow [.github/pull_request_template.md](.github/pull_request_template.md).
  Include `## Summary` and `## Validation`; explain the problem, resulting behavior,
  checks performed, and results. Include compatibility changes, migration steps,
  and material limitations when relevant.
- Omit conversational history, progress diaries, raw logs, and abandoned
  approaches. Link issues only when the PR actually resolves or relates to them.
