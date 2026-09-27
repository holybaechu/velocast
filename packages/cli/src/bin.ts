#!/usr/bin/env node

import { runCli } from "./cli.js";

async function main(): Promise<void> {
  try {
    const argv =
      process.argv[2] === "--"
        ? [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)]
        : process.argv;
    await runCli(argv);
  } catch (error) {
    console.error(formatCliError(error));
    process.exitCode = 1;
  }
}

void main();

function formatCliError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (process.env.VELOCAST_DEBUG?.trim()) {
    return error.stack ?? error.message;
  }
  return error.message;
}
