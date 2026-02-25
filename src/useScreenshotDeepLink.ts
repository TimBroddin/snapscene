import { useEffect, useRef } from "react";
import { useURL } from "expo-linking";
import type { Router } from "expo-router";
import { activate, deactivate, getState } from "./state";
import { run, teardown, getPassword, getDoneAfter } from "./registry";

interface UseScreenshotDeepLinkOptions<TContext = unknown> {
  /** App context forwarded to setup/teardown callbacks (e.g. Redux store) */
  ctx: TContext;
  /** Expo Router instance */
  router: Router;
}

/**
 * Hook that intercepts screenshot deep links and orchestrates scenario execution.
 *
 * When a deep link arrives with a `screenshotParams` query parameter, this hook:
 * 1. Validates the password (if configured)
 * 2. Activates screenshot state
 * 3. Runs globalSetup + scenario setup
 * 4. Navigates to the scenario route
 * 5. Optionally auto-fires done() after `doneAfter` ms
 *
 * Must be rendered inside the navigation tree (needs access to useRouter).
 */
export function useScreenshotDeepLink<TContext = unknown>({
  ctx,
  router,
}: UseScreenshotDeepLinkOptions<TContext>): void {
  const url = useURL();
  const lastUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!url || url === lastUrlRef.current) return;
    lastUrlRef.current = url;

    const parsed = new URL(url);
    const raw = parsed.searchParams.get("screenshotParams");
    if (!raw) return;

    let params: Record<string, string>;
    try {
      params = JSON.parse(raw);
    } catch {
      console.warn("[snapscene] Failed to parse screenshotParams:", raw);
      return;
    }

    const { scenario, port: portStr, deviceId, debug: debugFlag, ...rest } = params;

    // Password validation
    const password = getPassword();
    if (password) {
      const linkPassword = parsed.searchParams.get("password");
      if (linkPassword !== password) {
        console.warn("[snapscene] Password mismatch, ignoring deep link");
        return;
      }
    }

    if (!scenario) {
      console.warn("[snapscene] Missing scenario in screenshotParams");
      return;
    }

    const port = portStr ? parseInt(portStr, 10) : 0;
    const isDebug = debugFlag === "1";

    if (isDebug) {
      console.log(`[snapscene] Received deep link: scenario=${scenario} port=${port} deviceId=${deviceId}`);
    }

    // Activate state so useScreenshot() and getScreenshotState() work
    activate(scenario, port, deviceId, isDebug);

    const screenshotCtx = { ctx, router, params: rest };

    // Run the scenario (globalSetup -> setup -> navigate)
    run(scenario, screenshotCtx)
      .then(() => {
        // If this is a permutation-only deep link, signal ready immediately
        if (scenario === "__permutation" && port) {
          const { deviceId: did } = getState();
          fetch(`http://localhost:${port}/ready`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario, deviceId: did }),
          }).catch(() => {});
          return;
        }

        // Auto-done: if the scenario has doneAfter, schedule a ready callback
        const doneAfter = getDoneAfter(scenario);
        if (doneAfter > 0 && port) {
          setTimeout(() => {
            const { deviceId: did } = getState();
            fetch(`http://localhost:${port}/ready`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ scenario, deviceId: did, auto: true }),
            }).catch(() => {});
          }, doneAfter);
        }
      })
      .catch((err) => {
        console.error(`[snapscene] Scenario "${scenario}" failed:`, err);

        // Report error back to runner
        if (port) {
          const { deviceId: did } = getState();
          fetch(`http://localhost:${port}/error`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scenario,
              deviceId: did,
              error: String(err),
            }),
          }).catch(() => {});
        }
      });

    // Cleanup: teardown on unmount or next deep link
    return () => {
      teardown(scenario, screenshotCtx).catch(() => {});
      deactivate();
    };
  }, [url, ctx, router]);
}
