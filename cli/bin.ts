#!/usr/bin/env bun

import { createRunner, parseArgs, type RunnerConfig } from "./runner";

const configPath = process.argv[2];

if (!configPath || configPath.startsWith("--")) {
  console.error(
    "Usage: bunx snapscene <config.json> [--debug] [--screen home] [--device iPhone] [--<matrix-key> val]",
  );
  process.exit(1);
}

const file = Bun.file(configPath);
if (!(await file.exists())) {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}

// Shift argv so parseArgs doesn't see the config path
process.argv.splice(2, 1);

const config: RunnerConfig = await file.json();
await createRunner(parseArgs(config)).run();
