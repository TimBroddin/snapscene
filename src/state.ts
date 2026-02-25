/**
 * Singleton screenshot state.
 *
 * This module is intentionally a plain module-level variable (not React state)
 * so it can be read synchronously from anywhere — React hooks, Redux reducers,
 * utility functions, etc.
 */

interface ScreenshotState {
  /** Whether screenshot mode is currently active */
  active: boolean;
  /** The active scenario name */
  scenario: string | null;
  /** Port of the runner's HTTP callback server */
  port: number | null;
  /** Device UDID (used to correlate /ready callbacks in multi-device runs) */
  deviceId: string | null;
  /** Whether debug logging is enabled */
  debug: boolean;
}

let state: ScreenshotState = {
  active: false,
  scenario: null,
  port: null,
  deviceId: null,
  debug: false,
};

/** Read the current screenshot state (synchronous, works outside React). */
export function getState(): Readonly<ScreenshotState> {
  return state;
}

/** Activate screenshot mode with the given scenario and runner port. */
export function activate(
  scenario: string,
  port: number,
  deviceId?: string,
  debug?: boolean,
): void {
  state = {
    active: true,
    scenario,
    port: port || null,
    deviceId: deviceId ?? null,
    debug: debug ?? false,
  };
}

/** Deactivate screenshot mode, resetting all state. */
export function deactivate(): void {
  state = {
    active: false,
    scenario: null,
    port: null,
    deviceId: null,
    debug: false,
  };
}
