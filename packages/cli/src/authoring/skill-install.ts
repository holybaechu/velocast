import { access, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { VELOCAST_AGENT_SKILL } from "./templates/agent-skill.js";

export interface SkillInstallResult {
  projectDirectory: string;
  skillDirectory: string;
  files: string[];
}

export interface SkillInstallOptions {
  json?: boolean;
  write?: (text: string) => void;
}

export async function installProjectSkill(
  directory: string,
): Promise<SkillInstallResult> {
  const projectDirectory = resolve(directory);
  let projectStat;
  try {
    projectStat = await lstat(projectDirectory);
  } catch (error) {
    throw new Error(
      `skill.invalid_project: project directory does not exist: ${projectDirectory}`,
      {
        cause: error,
      },
    );
  }
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink())
    throw new Error(
      `skill.invalid_project: expected a real project directory: ${projectDirectory}`,
    );
  const markers = [
    "package.json",
    "velocast.config.ts",
    "velocast.config.js",
    "velocast.config.mjs",
  ];
  const markerChecks = await Promise.all(
    markers.map((marker) =>
      access(join(projectDirectory, marker)).then(
        () => true,
        () => false,
      ),
    ),
  );
  if (!markerChecks.some(Boolean))
    throw new Error(
      "skill.invalid_project: expected package.json or velocast.config.* in the selected project",
    );
  for (const ancestor of [
    join(projectDirectory, ".agents"),
    join(projectDirectory, ".agents", "skills"),
  ]) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink())
        throw new Error(
          `skill.invalid_target: symlinked agent directories are not supported: ${ancestor}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const skillDirectory = join(
    projectDirectory,
    ".agents",
    "skills",
    "velocast",
  );
  const relativeSkill = relative(projectDirectory, skillDirectory);
  if (
    !relativeSkill ||
    isAbsolute(relativeSkill) ||
    relativeSkill.startsWith("..")
  )
    throw new Error(
      "skill.invalid_target: project-local skill path escaped the project",
    );
  try {
    await mkdir(skillDirectory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(join(projectDirectory, ".agents", "skills"), {
        recursive: true,
      });
      await mkdir(skillDirectory);
    } else if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `skill.target_exists: refusing to overwrite ${skillDirectory}`,
        {
          cause: error,
        },
      );
    } else throw error;
  }
  try {
    await writeFile(join(skillDirectory, "SKILL.md"), VELOCAST_AGENT_SKILL, {
      flag: "wx",
    });
  } catch (error) {
    await rm(skillDirectory, { recursive: true, force: true });
    throw error;
  }
  return { projectDirectory, skillDirectory, files: ["SKILL.md"] };
}

export async function installSkillCommand(
  directory = ".",
  options: SkillInstallOptions = {},
): Promise<SkillInstallResult> {
  const result = await installProjectSkill(directory);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Installed project-local Velocast skill: ${result.skillDirectory}\n`,
  );
  return result;
}
