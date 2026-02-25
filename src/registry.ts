import type { Router, Href } from "expo-router";

export interface ScreenshotContext<TContext = unknown> {
  /** App-provided context (store, services, etc.) */
  ctx: TContext;
  router: Router;
  /** Decoded params from the deep link */
  params: Record<string, string>;
}

export interface ScenarioDefinition<TContext = unknown> {
  /** Route to navigate to after setup */
  route: string;
  /** Optional setup function (runs before navigation) */
  setup?: (ctx: ScreenshotContext<TContext>) => Promise<void> | void;
  /** Optional teardown function (runs on cleanup) */
  teardown?: (ctx: ScreenshotContext<TContext>) => Promise<void> | void;
  /** Max ms to wait for done() after navigation (overrides global timeout) */
  timeout?: number;
  /** Delay in ms before navigating after setup (overrides global navigationDelay) */
  navigationDelay?: number;
  /** Auto-call done() after this many ms post-navigation (for screens that don't call done() themselves) */
  doneAfter?: number;
}

interface GlobalConfig<TContext = unknown> {
  globalSetup?: (ctx: ScreenshotContext<TContext>) => Promise<void> | void;
  globalTeardown?: (ctx: ScreenshotContext<TContext>) => Promise<void> | void;
  /** Optional password — if set, deep links must include a matching password */
  password?: string;
  /** Default max ms to wait for done() after navigation (default: 30000) */
  timeout?: number;
  /** Default delay in ms before navigating after setup (default: 2000) */
  navigationDelay?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scenarios = new Map<string, ScenarioDefinition<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let globalConfig: GlobalConfig<any> = {};

/**
 * Configure global setup/teardown that runs for every scenario.
 */
export function configure<TContext = unknown>(config: GlobalConfig<TContext>) {
  globalConfig = config;
}

/**
 * Register a screenshot scenario.
 *
 * ```ts
 * registerScreenshotScenario('home-screen', {
 *   route: '/home',
 *   setup: ({ ctx }) => { ctx.dispatch(setUser(mockUser)); },
 * });
 * ```
 */
export function registerScreenshotScenario<TContext = unknown>(
  name: string,
  config: ScenarioDefinition<TContext>,
) {
  scenarios.set(name, config);
}

/** Get the configured password, if any */
export function getPassword(): string | undefined {
  return globalConfig.password;
}

/** Get the effective timeout for a scenario */
export function getTimeout(name: string): number {
  const scenario = scenarios.get(name);
  return scenario?.timeout ?? globalConfig.timeout ?? 30_000;
}

/** Get the doneAfter value for a scenario (0 = manual done()) */
export function getDoneAfter(name: string): number {
  const scenario = scenarios.get(name);
  return scenario?.doneAfter ?? 0;
}

/** @internal Run globalSetup only (used for permutation changes without kill) */
export async function runGlobalSetup<TContext = unknown>(
  ctx: ScreenshotContext<TContext>,
) {
  if (globalConfig.globalSetup) {
    await globalConfig.globalSetup(ctx);
  }
}

/** @internal Run a scenario: global setup -> scenario setup -> navigate */
export async function run<TContext = unknown>(
  name: string,
  ctx: ScreenshotContext<TContext>,
) {
  if (name === "__permutation") {
    // Permutation-only deep link — run globalSetup, skip scenario lookup
    await runGlobalSetup(ctx);
    return;
  }

  const scenario = scenarios.get(name);
  if (!scenario) {
    throw new Error(`[snapscene] Unknown scenario: "${name}"`);
  }

  if (globalConfig.globalSetup) {
    await globalConfig.globalSetup(ctx);
  }
  if (scenario.setup) {
    await scenario.setup(ctx);
  }
  const navDelay =
    scenario.navigationDelay ?? globalConfig.navigationDelay ?? 2000;
  await new Promise<void>((resolve) => setTimeout(resolve, navDelay));
  ctx.router.replace(scenario.route as Href);
}

/** @internal Teardown a scenario: scenario teardown -> global teardown */
export async function teardown<TContext = unknown>(
  name: string,
  ctx: ScreenshotContext<TContext>,
) {
  const scenario = scenarios.get(name);

  if (scenario?.teardown) {
    await scenario.teardown(ctx);
  }
  if (globalConfig.globalTeardown) {
    await globalConfig.globalTeardown(ctx);
  }
}

/** @internal List all registered scenario names (used by the bun runner) */
export function listScenarios(): string[] {
  return Array.from(scenarios.keys());
}
