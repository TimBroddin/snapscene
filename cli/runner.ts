/**
 * Bun-side screenshot runner.
 *
 * ```ts
 * import { createRunner, parseArgs } from 'snapscene/runner';
 *
 * const runner = createRunner(parseArgs({
 *   scheme: 'fpg',
 *   scenarios: ['home', 'truth-or-dare'],
 *   devices: ['iPhone 16 Pro Max'],
 *   matrix: { locale: ['en', 'de', 'fr'] },
 *   copyTo: './screenshots',
 * }));
 *
 * await runner.run();
 * ```
 */

import { $ } from "bun";

export interface ScenarioConfig {
  /** Scenario name (passed in screenshotParams) */
  name: string;
  /** Extra params merged into screenshotParams */
  params?: Record<string, string>;
  /** Timeout in ms waiting for done() (default: 30000) */
  timeout?: number;
  /** Numbered prefix for sorted filenames (e.g. '01') */
  filePrefix?: string;
}

export interface DeviceConfig {
  /** Device name (fuzzy matched against available simulators) */
  name: string;
  /** Extra wait in ms after each screenshot on this device (default: 0) */
  extraWait?: number;
}

export interface RunnerConfig {
  /** URL scheme (e.g. 'fpg') */
  scheme: string;
  /** Deep link path to open (e.g. 'home'). Produces scheme://homeRoute?screenshotParams=... */
  homeRoute?: string;
  /** Scenarios to capture */
  scenarios: (string | ScenarioConfig)[];
  /** Param variations to iterate over (cartesian product). Each key creates a subfolder level. */
  matrix?: Record<string, string[]>;
  /** Output directory for screenshots (default: /tmp/snapscene) */
  outputDir?: string;
  /** Copy screenshots to this directory after completion */
  copyTo?: string;
  /** Device names to capture on (fuzzy matched against available simulators) */
  devices?: (string | DeviceConfig)[];
  /** Extra params sent with every scenario */
  globalParams?: Record<string, string>;
  /** App bundle ID (used for killBetweenPermutations) */
  bundleId?: string;
  /** Kill and relaunch the app between matrix permutations (default: true, requires bundleId) */
  killBetweenPermutations?: boolean;
  /** Delay in ms after done() before taking the screenshot, for animations to settle (default: 200) */
  captureDelay?: number;
  /** Optional password (must match the password configured in the app) */
  password?: string;
  /** Enable verbose debug logging (default: false) */
  debug?: boolean;
  /** Extra delay in ms after globalSetup re-runs on permutation change, for async data to settle (default: 0) */
  waitAfterPermutationChange?: number;
}

function normalizeDevice(d: string | DeviceConfig): DeviceConfig {
  return typeof d === "string" ? { name: d } : d;
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  runtime: string;
}

/** A single combination from the matrix */
interface MatrixEntry {
  params: Record<string, string>;
  folder: string;
}

function normalizeScenario(s: string | ScenarioConfig): ScenarioConfig {
  return typeof s === "string" ? { name: s } : s;
}

/** Compute cartesian product of matrix values */
function expandMatrix(matrix: Record<string, string[]>): MatrixEntry[] {
  const keys = Object.keys(matrix);
  if (keys.length === 0) {
    return [{ params: {}, folder: "" }];
  }

  let entries: MatrixEntry[] = [{ params: {}, folder: "" }];

  for (const key of keys) {
    const values = matrix[key];
    const next: MatrixEntry[] = [];
    for (const entry of entries) {
      for (const value of values) {
        next.push({
          params: { ...entry.params, [key]: value },
          folder: entry.folder ? `${entry.folder}/${value}` : value,
        });
      }
    }
    entries = next;
  }

  return entries;
}

/**
 * Parse CLI args to override runner config.
 * Supports: --screen home,levels  --device "iPhone 16"  --KEY val (overrides matrix key)
 */
export function parseArgs(config: RunnerConfig): RunnerConfig {
  const args = process.argv.slice(2);
  const result = { ...config };
  const matrixOverrides: Record<string, string[]> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--debug") {
      result.debug = true;
    } else if (arg === "--screen") {
      const names = args[++i].split(",");
      const all = config.scenarios.map(normalizeScenario);
      result.scenarios = all.filter((s) => names.includes(s.name));
    } else if (arg === "--device") {
      result.devices = args[++i].split(",");
    } else if (arg.startsWith("--") && config.matrix) {
      const key = arg.slice(2);
      if (key in config.matrix) {
        matrixOverrides[key] = args[++i].split(",");
      }
    }
  }

  if (Object.keys(matrixOverrides).length > 0 && config.matrix) {
    result.matrix = { ...config.matrix, ...matrixOverrides };
  }

  return result;
}

// --- Fuzzy matching ---

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fuzzyScore(query: string, candidate: string): number {
  const nq = normalize(query);
  const nc = normalize(candidate);
  if (nc === nq) return 100;
  if (nc.includes(nq)) return 80;
  const queryWords = query.toLowerCase().split(/\s+/);
  if (queryWords.every((w) => candidate.toLowerCase().includes(w))) return 60;
  return 0;
}

async function promptChoice(
  question: string,
  choices: string[],
): Promise<number> {
  console.log(`\n${question}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]}`);
  }

  process.stdout.write("\nChoice: ");

  for await (const line of console) {
    const num = parseInt(line.trim(), 10);
    if (num >= 1 && num <= choices.length) {
      return num - 1;
    }
    process.stdout.write(`Invalid choice. Enter 1-${choices.length}: `);
  }

  throw new Error("stdin closed");
}

// --- Debug logging ---

const TAG = "[snapscene]";

// --- Runner ---

export function createRunner(config: RunnerConfig) {
  const {
    scheme,
    homeRoute = "index",
    scenarios: rawScenarios,
    matrix = {},
    outputDir = "/tmp/snapscene",
    copyTo,
    devices: rawDevices = [],
    globalParams = {},
    bundleId,
    killBetweenPermutations = true,
    captureDelay = 200,
    password,
    debug: isDebug = false,
    waitAfterPermutationChange = 0,
  } = config;

  function debug(...args: unknown[]) {
    if (!isDebug) return;
    console.log(TAG, ...args);
  }

  const deviceConfigs = rawDevices.map(normalizeDevice);
  const scenarios = rawScenarios.map(normalizeScenario);
  const matrixEntries = expandMatrix(matrix);

  // --- Ready callback server (supports parallel devices) ---
  interface ReadyPayload {
    scenario: string;
    auto?: boolean;
    deviceId?: string;
  }
  interface DeviceCallback {
    resolve: (value: ReadyPayload) => void;
    reject: (error: Error) => void;
  }
  const pendingCallbacks = new Map<string, DeviceCallback>();

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/ready") {
        return req
          .json()
          .then((body: ReadyPayload) => {
            const key = body.deviceId ?? "booted";
            debug(
              "Received /ready from",
              key,
              "for:",
              body.scenario,
              body.auto ? "(auto)" : "(manual)",
            );
            pendingCallbacks.get(key)?.resolve(body);
            pendingCallbacks.delete(key);
            return new Response("ok");
          })
          .catch(() => new Response("ok"));
      }
      if (url.pathname === "/error") {
        return req
          .json()
          .then(
            ({
              scenario,
              deviceId,
              error,
            }: {
              scenario: string;
              deviceId?: string;
              error: string;
            }) => {
              const key = deviceId ?? "booted";
              debug("Received /error from", key, ":", scenario, error);
              pendingCallbacks
                .get(key)
                ?.reject(new Error(`Scenario "${scenario}" failed: ${error}`));
              pendingCallbacks.delete(key);
              return new Response("ok");
            },
          )
          .catch(() => new Response("ok"));
      }
      return new Response("not found", { status: 404 });
    },
  });

  function waitForReady(
    deviceId: string,
    timeoutMs: number,
  ): Promise<ReadyPayload | "timeout"> {
    return new Promise<ReadyPayload | "timeout">((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCallbacks.delete(deviceId);
        resolve("timeout");
      }, timeoutMs);

      pendingCallbacks.set(deviceId, {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  // --- Simulator helpers ---

  async function listSimDevices(): Promise<SimDevice[]> {
    const result = await $`xcrun simctl list devices -j`.json();
    const all: SimDevice[] = [];
    for (const [runtime, runtimeDevices] of Object.entries(result.devices) as [
      string,
      Omit<SimDevice, "runtime">[],
    ][]) {
      for (const device of runtimeDevices) {
        all.push({ ...device, runtime });
      }
    }
    return all.filter((d) => d.isAvailable);
  }

  function runtimeLabel(runtime: string): string {
    // com.apple.CoreSimulator.SimRuntime.iOS-26-2 -> iOS 26.2
    const match = runtime.match(/SimRuntime\.(\w+)-(.+)$/);
    if (!match) return runtime;
    return `${match[1]} ${match[2].replace(/-/g, ".")}`;
  }

  function deviceLabel(d: SimDevice): string {
    return `${d.name} (${runtimeLabel(d.runtime)}, ${d.state})`;
  }

  async function resolveDevice(
    query: string,
    available: SimDevice[],
  ): Promise<SimDevice> {
    const scored = available
      .map((d) => ({ device: d, score: fuzzyScore(query, d.name) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      throw new Error(
        `No simulator matching "${query}". Available:\n${available.map((d) => `  - ${deviceLabel(d)}`).join("\n")}`,
      );
    }

    if (scored.length === 1 || scored[0].score > scored[1].score) {
      debug(`Matched "${query}" -> ${deviceLabel(scored[0].device)}`);
      return scored[0].device;
    }

    // Multiple equally good matches — prefer a booted one
    const topScore = scored[0].score;
    const ties = scored.filter((s) => s.score === topScore);
    const booted = ties.filter((t) => t.device.state === "Booted");

    if (booted.length === 1) {
      debug(
        `Matched "${query}" -> ${deviceLabel(booted[0].device)} (already booted)`,
      );
      return booted[0].device;
    }

    // Still ambiguous — ask the user
    const choices = booted.length > 1 ? booted : ties;
    const idx = await promptChoice(
      `Multiple simulators match "${query}":`,
      choices.map((t) => deviceLabel(t.device)),
    );
    return choices[idx].device;
  }

  async function ensureBooted(device: SimDevice): Promise<string> {
    if (device.state !== "Booted") {
      debug("Booting:", device.name);
      await $`xcrun simctl boot ${device.udid}`.quiet();
      await Bun.sleep(5000);
    }
    return device.udid;
  }

  // --- Main runner ---

  async function runOnDevice(
    udid: string,
    deviceName: string,
    deviceFolder: string,
    extraWait: number,
  ) {
    const deviceId = udid;
    const total = matrixEntries.length * scenarios.length;
    let count = 0;

    const dir = [outputDir, deviceFolder].filter(Boolean).join("/");
    await $`mkdir -p ${dir}`.quiet();

    for (const entry of matrixEntries) {
      if (killBetweenPermutations && bundleId) {
        debug("Killing app:", bundleId);
        await $`xcrun simctl terminate ${udid} ${bundleId}`.quiet().nothrow();
        await Bun.sleep(1000);
      } else if (count > 0) {
        // App is still running — send a permutation deep link so globalSetup
        // can re-run (e.g. load new locale data) before we start scenarios.
        debug("Sending permutation change deep link");
        const permParams = JSON.stringify({
          scenario: "__permutation",
          deviceId,
          port: String(server.port),
          ...(isDebug ? { debug: "1" } : {}),
          ...globalParams,
          ...entry.params,
        });
        const permQuery = new URLSearchParams({
          screenshotParams: permParams,
          ...(password ? { password } : {}),
        });
        const permUrl = `${scheme}://${homeRoute}?${permQuery}`;
        await $`xcrun simctl openurl ${udid} ${permUrl}`.quiet();
        const permResult = await waitForReady(deviceId, 30_000);
        if (permResult === "timeout") {
          debug("Permutation change timed out");
        }
        if (waitAfterPermutationChange > 0) {
          debug(`Waiting ${waitAfterPermutationChange}ms for data to settle`);
          await Bun.sleep(waitAfterPermutationChange);
        }
      }

      // Matrix values become a filename prefix: "en_01.png"
      const matrixPrefix = entry.folder
        ? `${entry.folder.replace(/\//g, "_")}_`
        : "";

      for (const scenario of scenarios) {
        count++;
        const filePart = scenario.filePrefix ?? scenario.name;
        const filename = `${dir}/${matrixPrefix}${filePart}.png`;
        const label = entry.folder
          ? `${entry.folder}/${scenario.name}`
          : scenario.name;

        process.stdout.write(`   [${count}/${total}] ${label}...`);

        const screenshotParams = JSON.stringify({
          scenario: scenario.name,
          deviceId,
          port: String(server.port),
          ...(isDebug ? { debug: "1" } : {}),
          ...globalParams,
          ...entry.params,
          ...scenario.params,
        });

        const queryParams = new URLSearchParams({
          screenshotParams,
          ...(password ? { password } : {}),
        });

        const url = `${scheme}://${homeRoute}?${queryParams}`;
        debug("Opening URL:", url);
        await $`xcrun simctl openurl ${udid} ${url}`.quiet();
        debug("Waiting for ready (timeout:", scenario.timeout ?? 30_000, "ms)");

        const timeout = scenario.timeout ?? 30_000;
        const result = await waitForReady(deviceId, timeout);

        let reason: string;
        if (result === "timeout") {
          reason = "timeout";
        } else if (result.auto) {
          reason = `doneAfter`;
          if (captureDelay > 0) {
            reason += ` +${captureDelay}ms`;
            await Bun.sleep(captureDelay);
          }
        } else {
          reason = "done()";
        }

        debug("Taking screenshot:", filename);
        await $`xcrun simctl io ${udid} screenshot ${filename}`.quiet();

        console.log(` ${reason}`);

        if (extraWait > 0) {
          debug(`Extra wait: ${extraWait}ms`);
          await Bun.sleep(extraWait);
        }
      }
      console.log();
    }

    console.log(`   Done with ${deviceName} (${count} screenshots)\n`);
  }

  return {
    port: server.port,

    async run() {
      const matrixDesc = Object.entries(matrix)
        .map(([k, v]) => `${k}: ${v.join(", ")}`)
        .join(" | ");

      console.log("Screenshot automation starting...");
      console.log(`   Scenarios: ${scenarios.map((s) => s.name).join(", ")}`);
      if (matrixDesc) console.log(`   Matrix: ${matrixDesc}`);
      console.log(
        `   Permutations: ${matrixEntries.length} x ${scenarios.length} scenarios = ${matrixEntries.length * scenarios.length} per device`,
      );
      console.log(
        `   Devices: ${deviceConfigs.length ? deviceConfigs.map((d) => d.name).join(", ") : "(booted)"}`,
      );
      console.log(
        `   Kill between permutations: ${killBetweenPermutations && !!bundleId}`,
      );
      console.log(`   Output: ${outputDir}${copyTo ? ` -> ${copyTo}` : ""}`);
      if (isDebug) console.log(`   Debug: on`);
      console.log(`   Ready server: http://localhost:${server.port}`);

      try {
        if (deviceConfigs.length === 0) {
          console.log("\n   Using booted simulator");
          await runOnDevice("booted", "booted", "", 0);
        } else {
          const available = await listSimDevices();
          debug(`Found ${available.length} available simulators`);

          for (const dc of deviceConfigs) {
            const device = await resolveDevice(dc.name, available);
            const udid = await ensureBooted(device);
            const folder = device.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/-+$/, "");
            console.log(
              `\n   Device: ${device.name} (${udid})${dc.extraWait ? ` [+${dc.extraWait}ms per screenshot]` : ""}`,
            );
            await runOnDevice(udid, device.name, folder, dc.extraWait ?? 0);
          }
        }
      } finally {
        server.stop();
      }

      if (copyTo) {
        debug("Copying:", outputDir, "->", copyTo);
        await $`rm -rf ${copyTo}`.quiet();
        await $`cp -R ${outputDir} ${copyTo}`.quiet();
      }

      console.log("All done!");
    },

    stop() {
      server.stop();
    },
  };
}
