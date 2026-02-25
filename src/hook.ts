import { useCallback } from "react";
import { getState } from "./state";

export interface UseScreenshotResult {
  /** Whether the current render is inside a screenshot scenario */
  isScreenshot: boolean;
  /** The active scenario name, or null if not in a screenshot */
  scenario: string | null;
  /** Call when the screen is visually ready for capture */
  done: () => void;
}

/**
 * Hook for components to signal screenshot readiness.
 *
 * In normal (non-screenshot) context, `isScreenshot` is false, `scenario` is null,
 * and `done` is a noop.
 *
 * ```ts
 * const { isScreenshot, scenario, done } = useScreenshot();
 *
 * useEffect(() => {
 *   if (scenario === 'levels') {
 *     scrollRef.current?.scrollTo({ y: 400, animated: false });
 *   }
 *   if (isScreenshot && dataLoaded) done();
 * }, [isScreenshot, scenario, dataLoaded]);
 * ```
 */
export function useScreenshot(): UseScreenshotResult {
  const { active, scenario, port } = getState();

  const done = useCallback(() => {
    if (!port) return;

    const { deviceId } = getState();

    // Wait 2 rAF ticks so React Native flushes all pending layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fetch(`http://localhost:${port}/ready`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario, deviceId }),
        }).catch(() => {
          // Silently ignore - script may not be listening
        });
      });
    });
  }, [port, scenario]);

  if (!active) {
    return { isScreenshot: false, scenario: null, done: noop };
  }

  return { isScreenshot: true, scenario, done };
}

function noop() {}
