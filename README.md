# snapscene

Automated App Store screenshot capture for React Native apps with Expo Router.

Snapscene coordinates between a **Bun CLI runner** that drives iOS simulators and **React hooks** inside your app that signal when each screen is ready to capture.

## Install

```bash
bun add -d snapscene
```

## How it works

```
Runner (Bun)                              App (React Native)
─────────────                             ──────────────────
  open deep link ──────────────────────▶  useScreenshotDeepLink
  (scheme://home?screenshotParams=...)       │
                                             ├─ globalSetup()
  start HTTP server on random port           ├─ scenario.setup()
  waiting for /ready POST...                 ├─ navigate to route
                                             │
                                             ▼
                                          Screen renders
                                             │
  ◀──── POST /ready ────────────────────  done() or doneAfter
  capture screenshot via simctl
  next scenario...
```

The runner opens a deep link on the simulator. The app receives it via `useScreenshotDeepLink`, which runs your setup code (dispatching Redux actions, loading mock data, etc.), then navigates to the scenario's route. Once the screen is ready, it signals back to the runner via an HTTP callback. The runner takes a screenshot and moves on to the next scenario.

## Integration guide

There are three pieces to wire up: a **scenario file**, the **deep link hook** in your root layout, and optional **readiness signals** in individual screens.

### The `ctx` parameter

Every `setup`, `teardown`, and `globalSetup` callback receives a `ctx` parameter. This is **whatever object you pass** to `useScreenshotDeepLink({ ctx, router })` — snapscene just forwards it through. There's no magic registration; you control what it is.

For most apps, `ctx` is your Redux store, which lets setup callbacks dispatch actions:

```tsx
// In your root layout (step 2 below):
useScreenshotDeepLink({ ctx: store, router });
//                       ^^^^^^^^^^^
//                       This exact object becomes `ctx` in all callbacks

// In your scenario setup (step 1 below):
setup: ({ ctx }) => {
  ctx.dispatch(loadGameState()); // ctx IS store — you can dispatch, getState(), etc.
};
```

The generic type parameter `<Store>` gives you type safety:

```ts
configure<Store>({ ... });                        // ctx is typed as Store
registerScreenshotScenario<Store>("home", { ... }); // same
```

If you don't use Redux, `ctx` can be anything — a Zustand store, a plain object with helper methods, or even `null` if your setup doesn't need app state.

### Step 1: Define your scenarios

Create a file that registers all your screenshot scenarios. This file runs as a side-effect import — it just calls `configure()` and `registerScreenshotScenario()` at module scope.

```ts
// screenshots.ts
import { registerScreenshotScenario, configure } from "snapscene";
import type { Store } from "@reduxjs/toolkit";

// configure() sets up global behavior that runs for EVERY scenario.
configure<Store>({
  globalSetup: async ({ ctx, params }) => {
    // `ctx` is your Redux store (passed via useScreenshotDeepLink in step 2)
    // `params` contains matrix values from the runner (e.g. params.locale)
    if (params.locale) ctx.dispatch(setLanguage(params.locale));
    ctx.dispatch(loadMockPlayers());
    ctx.dispatch(simulatePurchase());
  },
});

// Each scenario maps a name to a route + optional setup/teardown.
registerScreenshotScenario<Store>("home", {
  route: "/home",
  doneAfter: 3000, // static screen — auto-capture after 3s, no need for done()
});

registerScreenshotScenario<Store>("game", {
  route: "/game",
  setup: ({ ctx }) => {
    // Scenario-specific setup runs AFTER globalSetup, BEFORE navigation
    ctx.dispatch(loadGameState({ level: 3 }));
  },
  // This screen calls done() manually (see step 3)
});

registerScreenshotScenario<Store>("settings", {
  route: "/settings",
  doneAfter: 2000,
  setup: ({ ctx }) => {
    ctx.dispatch(enableFeatureFlag("darkMode"));
  },
  teardown: ({ ctx }) => {
    ctx.dispatch(disableFeatureFlag("darkMode"));
  },
});
```

### Step 2: Add the deep link hook to your root layout

`useScreenshotDeepLink` listens for incoming deep links via Expo's `useURL()` hook. When a screenshot deep link arrives, it:

1. Validates the password (if configured)
2. Calls `globalSetup()` then `scenario.setup()` — this is where `ctx` gets used
3. Waits for `navigationDelay` (default 2s)
4. Navigates to the scenario's route via `router.replace()`

The hook needs two things: access to `useRouter()` (so it must be inside the navigation tree) and your app context (the Redux store, passed as `ctx`).

```tsx
// app/_layout.tsx
import { useRouter } from "expo-router";
import { Stack } from "expo-router";
import { store, Provider } from "./store";
import { useScreenshotDeepLink } from "snapscene";

// Side-effect import — registers all scenarios defined in step 1.
// Must be imported before the component renders.
import "../screenshots";

export default function RootLayout() {
  return (
    <Provider store={store}>
      <Stack>
        <Stack.Screen name="index" />
        <Stack.Screen name="home" />
        <Stack.Screen name="game" />
        <Stack.Screen name="settings" />
      </Stack>
      {/* Rendered as a child of Stack so it has access to useRouter() */}
      <ScreenshotHandler />
    </Provider>
  );
}

function ScreenshotHandler() {
  const router = useRouter();

  // `store` is your Redux store — it becomes `ctx` in all setup/teardown callbacks.
  // `router` is used to navigate to scenario routes.
  useScreenshotDeepLink({ ctx: store, router });

  return null; // this component renders nothing — it only runs the hook
}
```

**Why a separate component?** `useScreenshotDeepLink` uses `useURL()` internally, which requires a navigation context. Your root layout _creates_ the `<Stack>`, so the hook can't be called directly in `RootLayout` — it needs to be in a component that renders _inside_ the stack. The `ScreenshotHandler` pattern is just a React idiom for "run this hook inside this context tree."

In a real app, you likely already have a component like this for other effects (analytics, auth redirects, etc.) — the hook can go there too:

```tsx
function AppEffects() {
  const router = useRouter();
  const posthog = usePostHog();

  // Screenshot deep link handling
  useScreenshotDeepLink({ ctx: store, router });

  // Your other effects...
  useEffect(() => {
    posthog.capture("app_opened");
  }, []);

  return null;
}
```

### Step 3: Signal readiness from screens (optional)

For screens with async content (data fetching, animations), use the `useScreenshot` hook to tell the runner when the screen is visually ready:

```tsx
// screens/Game.tsx
import { useEffect, useState } from "react";
import { useScreenshot } from "snapscene";

export function GameScreen() {
  const [dataLoaded, setDataLoaded] = useState(false);
  const { isScreenshot, done } = useScreenshot();

  useEffect(() => {
    fetchGameData().then(() => setDataLoaded(true));
  }, []);

  // Signal readiness once data is loaded (only during screenshot mode)
  useEffect(() => {
    if (isScreenshot && dataLoaded) done();
  }, [isScreenshot, dataLoaded, done]);

  if (!dataLoaded) return <LoadingSpinner />;
  return <GameBoard />;
}
```

For static screens that don't need to wait for anything, skip this step and use `doneAfter` in the scenario definition instead (see step 1).

You can also use `getScreenshotState()` outside of React (in Redux reducers, utility functions, etc.) to check if screenshot mode is active:

```ts
import { getScreenshotState } from "snapscene";

// In a Redux reducer or any non-React code
if (getScreenshotState().active) {
  // Skip reset logic, hide modals, etc.
}
```

### Step 4: Create a runner config file

```json
{
  "$schema": "./node_modules/snapscene/schema.json",
  "scheme": "myapp",
  "scenarios": [
    { "name": "home", "filePrefix": "01" },
    { "name": "game", "filePrefix": "02" },
    { "name": "settings", "filePrefix": "03" }
  ],
  "matrix": {
    "locale": ["en", "de", "fr", "es"]
  },
  "devices": ["iPhone 16 Pro Max", "iPad Pro 13-inch (M4)"],
  "bundleId": "com.example.myapp",
  "copyTo": "./screenshots",
  "killBetweenPermutations": false,
  "waitAfterPermutationChange": 5000
}
```

The `matrix` creates a cartesian product — every scenario is captured for every combination of matrix values. Each matrix key becomes a subfolder in the output.

### Step 5: Run

```bash
# Run all scenarios on all devices and locales
bunx snapscene screenshots.config.json

# Run specific scenarios only
bunx snapscene screenshots.config.json --screen home,game

# Run for specific locales only
bunx snapscene screenshots.config.json --locale en,de

# Verbose logging (also enables debug logs in the app)
bunx snapscene screenshots.config.json --debug
```

Output:

```
screenshots/
  iphone-16-pro-max/
    en/
      01-home.png
      02-game.png
      03-settings.png
    de/
      01-home.png
      ...
  ipad-pro-13-inch-m4/
    en/
      ...
```

## API reference

### App-side exports

| Export                                   | Description                                                     |
| ---------------------------------------- | --------------------------------------------------------------- |
| `configure(config)`                      | Set global setup/teardown, password, default timeouts           |
| `registerScreenshotScenario(name, def)`  | Register a named scenario with route, setup, and options        |
| `useScreenshotDeepLink({ ctx, router })` | Hook that intercepts deep links and orchestrates scenarios      |
| `useScreenshot()`                        | Hook returning `{ isScreenshot, scenario, done }`               |
| `getScreenshotState()`                   | Synchronous state check — works outside React (reducers, utils) |

### Scenario options

```ts
interface ScenarioDefinition<TContext> {
  route: string; // Expo Router path
  setup?: (ctx: ScreenshotContext<TContext>) => void; // runs before navigation
  teardown?: (ctx: ScreenshotContext<TContext>) => void; // runs on cleanup
  timeout?: number; // max ms to wait for done() (default: 30000)
  navigationDelay?: number; // ms to wait after setup before navigating (default: 2000)
  doneAfter?: number; // auto-signal readiness after N ms (0 = manual)
}

interface ScreenshotContext<TContext> {
  ctx: TContext; // your app context (Redux store, etc.)
  router: Router; // Expo Router instance
  params: Record<string, string>; // deep link params (matrix values, etc.)
}
```

### Runner config

| Option                       | Default          | Description                                                                             |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `scheme`                     | (required)       | URL scheme for deep links                                                               |
| `scenarios`                  | (required)       | Array of scenario names or `{ name, filePrefix, params, timeout }`                      |
| `matrix`                     | `{}`             | Cartesian product of param variations (each key = subfolder)                            |
| `devices`                    | `[]`             | Simulator names (fuzzy matched against available simulators)                            |
| `outputDir`                  | `/tmp/snapscene` | Where screenshots are written                                                           |
| `copyTo`                     | -                | Copy final output to this directory                                                     |
| `bundleId`                   | -                | App bundle ID (needed for `killBetweenPermutations`)                                    |
| `killBetweenPermutations`    | `true`           | Kill and relaunch app between matrix permutation changes                                |
| `waitAfterPermutationChange` | `0`              | Extra delay (ms) after globalSetup re-runs on permutation change                        |
| `captureDelay`               | `200`            | Delay (ms) before capture, only for `doneAfter` auto-done (skipped for manual `done()`) |
| `password`                   | -                | Shared secret for deep link validation (see below)                                      |

### Permutation changes

When `killBetweenPermutations` is `false` and the matrix changes (e.g. switching from `locale: "en"` to `locale: "de"`), the runner sends a special deep link that re-runs your `globalSetup` with the new params. This lets you dispatch actions like loading a new language, switching themes, etc. The runner waits for `globalSetup` to complete before starting scenarios.

If your app also needs time for async side-effects after `globalSetup` (e.g. React Query refetches triggered by a locale change), set `waitAfterPermutationChange` to add an extra delay after the setup completes.

When `killBetweenPermutations` is `true` (the default), the app is killed and relaunched for each permutation, so `globalSetup` runs naturally on the first scenario's deep link.

### Password protection

Screenshot setup callbacks often grant elevated access — simulating in-app purchases, unlocking premium content, loading mock data. Without a password, anyone who knows your URL scheme could craft a deep link that triggers this setup on a real device, effectively bypassing your paywall.

Set a shared password in both `configure()` and the runner config:

```ts
// screenshots.ts
configure<Store>({
  password: "s3cret",
  globalSetup: ({ ctx }) => {
    ctx.dispatch(simulateIAP()); // unlocks all premium content
  },
});
```

```json
// screenshots.config.json
{
  "password": "s3cret"
}
```

The runner includes the password in the deep link query string. The app-side hook rejects any deep link where the password doesn't match, so the setup callbacks never run.

### CLI flags

```bash
bunx snapscene <config.json> [options]

  --debug              Verbose logging in runner and app
  --screen home,game   Only run these scenarios (comma-separated)
  --device "iPhone 16" Only run on these devices (comma-separated)
  --<matrix-key> val   Override matrix values (e.g. --locale en,de)
```
