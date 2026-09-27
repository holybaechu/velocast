# Agent instructions

These requirements apply to all work in this repository.

## Commits and pull requests

- Use Conventional Commits for every commit and PR title:
  `type(scope): imperative summary`. The scope is optional. Use `feat`, `fix`,
  `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`
  according to the change.
- Mark breaking changes with `!` after the type or scope and a
  `BREAKING CHANGE:` footer explaining the impact and migration.
- Write PR descriptions with `## Summary` and `## Validation`. Explain the
  concrete problem and resulting behavior, then state the checks performed and
  their results. Include compatibility changes, migration steps, and material
  limitations when relevant. Report blocked or unrun checks explicitly.
- Keep titles and descriptions aligned with the final diff. Omit conversational
  history, progress diaries, raw logs, and abandoned approaches. Use the same
  commit convention for merge and squash commit subjects.

## Repository files and temporary work

- Write files in the repository only when they are maintained project inputs or
  required deliverables: source, tests, fixtures, configuration, documentation,
  or intentionally versioned assets. An ignore rule does not make a directory
  appropriate for temporary work.
- Create a unique, task-specific directory under the operating system's
  temporary directory, outside every repository and worktree, for scratch
  scripts, logs, benchmark outputs, generated reports, media, archives, and PR
  body files. Direct temporary build outputs and caches there when configurable.
- Keep only durable findings needed by the project in repository documentation;
  leave raw execution evidence and intermediate files in the temporary directory.
- Delete task-created temporary files and directories when they are no longer
  needed and before finishing the task, including after failures. If the user
  explicitly requests an artifact, retain the deliverable at an agreed location
  and remove its intermediates.
- Before recursive cleanup, resolve the absolute path, verify it is outside the
  repository and belongs to the current task, and stop processes using it. Delete
  only task-owned paths; preserve pre-existing and unrelated files.
- Before committing, inspect the staged diff and untracked files. Include only
  intentional repository changes and confirm temporary work has been cleaned up.
