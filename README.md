# snapscene

Automated App Store screenshot capture for Expo apps.

I ship several iOS apps and got tired of the screenshot workflow. Taking them manually means clicking through every screen, on every device, in every language — for every release. I tried Maestro, but fighting YAML configs to get app state right (mocking purchases, switching locales, loading test data) felt like the wrong abstraction. My app already knows how to set itself up — it just needed a way to be told _when_.

Snapscene flips the approach: a **Bun CLI runner** drives iOS simulators via deep links, and **React hooks** inside your app handle setup and signal when each screen is ready. You write your screenshot scenarios in TypeScript, right next to your app code, using the same stores and dispatchers you already have.

3 screens, 4 locales, 2 devices = **24 screenshots**, fully automated.

```bash
bunx snapscene screenshots.config.json
```

```
screenshots/
  iphone-17-pro/
    en/
      01-home.png
      02-game.png
      03-settings.png
    de/
      01-home.png
      ...
  ipad-pro-13-inch-m5/
    en/
      ...
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

The runner opens a deep link on the simulator. Your app receives it, runs your setup code (dispatching Redux actions, loading mock data, etc.), navigates to the route, and signals back when the screen is ready. The runner takes a screenshot and moves on.

## Install

```bash
bun add snapscene
# or
npm install snapscene
# or
yarn add snapscene
```

> **Note:** The app-side hooks work with any bundler (Metro, etc.), but the CLI runner requires [Bun](https://bun.sh).

## Quick start

There are three pieces to wire up: **scenarios**, a **deep link hook** in your root layout, and optional **readiness signals** in individual screens.

### 1. Define your scenarios

```ts
// screenshots.ts
import { registerScreenshotScenario, configure } from "snapscene";
import type { Store } from "@reduxjs/toolkit";

configure<Store>({
  globalSetup: async ({ ctx, params }) => {
    if (params.locale) ctx.dispatch(setLanguage(params.locale));
    ctx.dispatch(loadMockPlayers());
    ctx.dispatch(simulatePurchase());
  },
});

registerScreenshotScenario<Store>("home", {
  route: "/home",
  doneAfter: 3000, // static screen — auto-capture after 3s
});

registerScreenshotScenario<Store>("game", {
  route: "/game",
  setup: ({ ctx }) => {
    ctx.dispatch(loadGameState({ level: 3 }));
  },
  // this screen calls done() manually (see step 3)
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

### 2. Add the deep link hook

```tsx
// app/_layout.tsx
import { useRouter } from "expo-router";
import { Stack } from "expo-router";
import { store, Provider } from "./store";
import { useScreenshotDeepLink } from "snapscene";
import "../screenshots"; // side-effect import — registers scenarios

export default function RootLayout() {
  return (
    <Provider store={store}>
      <Stack>
        <Stack.Screen name="index" />
        <Stack.Screen name="home" />
        <Stack.Screen name="game" />
        <Stack.Screen name="settings" />
      </Stack>
      <ScreenshotHandler />
    </Provider>
  );
}

function ScreenshotHandler() {
  const router = useRouter();
  useScreenshotDeepLink({ ctx: store, router });
  return null;
}
```

**Why a separate component?** `useScreenshotDeepLink` calls `useURL()` internally, which needs a navigation context. Your root layout _creates_ the `<Stack>`, so the hook must be in a component that renders _inside_ it. If you already have an `AppEffects` component for analytics/auth, the hook can go there.

### 3. Signal readiness from screens (optional)

For screens with async content, use `useScreenshot` to tell the runner when the screen is visually ready:

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

  useEffect(() => {
    if (isScreenshot && dataLoaded) done();
  }, [isScreenshot, dataLoaded, done]);

  if (!dataLoaded) return <LoadingSpinner />;
  return <GameBoard />;
}
```

For static screens, skip this and use `doneAfter` in the scenario definition instead.

You can also check screenshot state outside React:

```ts
import { getScreenshotState } from "snapscene";

if (getScreenshotState().active) {
  // skip reset logic, hide modals, etc.
}
```

### 4. Create a runner config

```json
{
  "$schema": "./node_modules/snapscene/schema.json",
  "scheme": "myapp",
  "homeRoute": "home",
  "scenarios": [
    { "name": "home", "filePrefix": "01" },
    { "name": "game", "filePrefix": "02" },
    { "name": "settings", "filePrefix": "03" }
  ],
  "matrix": {
    "locale": ["en-US", "de-DE", "fr-FR", "es-ES"]
  },
  "devices": [
    "iPhone 17 Pro",
    { "name": "iPad Pro 13-inch (M5)", "extraWait": 3000 }
  ],
  "bundleId": "com.example.myapp",
  "copyTo": "./screenshots",
  "killBetweenPermutations": false,
  "waitAfterPermutationChange": 15000,
  "captureDelay": 1500
}
```

### 5. Run

```bash
bunx snapscene screenshots.config.json

# specific scenarios only
bunx snapscene screenshots.config.json --screen home,game

# specific locales only
bunx snapscene screenshots.config.json --locale en,de

# verbose logging
bunx snapscene screenshots.config.json --debug
```

## The `ctx` parameter

Every `setup`, `teardown`, and `globalSetup` callback receives a `ctx` parameter. This is **whatever object you pass** to `useScreenshotDeepLink({ ctx, router })` — snapscene just forwards it.

For most apps, `ctx` is your Redux store:

```tsx
useScreenshotDeepLink({ ctx: store, router });

// In your scenario:
setup: ({ ctx }) => {
  ctx.dispatch(loadGameState()); // ctx IS store
};
```

The generic type parameter gives you type safety:

```ts
configure<Store>({ ... });
registerScreenshotScenario<Store>("home", { ... });
```

If you don't use Redux, `ctx` can be anything — a Zustand store, a plain object, or `null`.

## Reference

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

| Option                       | Default          | Description                                                                           |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `scheme`                     | (required)       | URL scheme for deep links                                                             |
| `homeRoute`                  | `"index"`        | Deep link path to open                                                                |
| `scenarios`                  | (required)       | Array of scenario names or `{ name, filePrefix, params, timeout }`                    |
| `matrix`                     | `{}`             | Cartesian product of param variations (each key = subfolder)                          |
| `devices`                    | `[]`             | Simulator names or `{ name, extraWait }` (fuzzy matched)                              |
| `globalParams`               | `{}`             | Extra params sent with every scenario deep link                                       |
| `outputDir`                  | `/tmp/snapscene` | Where screenshots are written                                                         |
| `copyTo`                     | -                | Copy final output to this directory                                                   |
| `bundleId`                   | -                | App bundle ID (needed for `killBetweenPermutations`)                                  |
| `killBetweenPermutations`    | `true`           | Kill and relaunch app between matrix permutation changes                              |
| `waitAfterPermutationChange` | `0`              | Extra delay (ms) after globalSetup re-runs on permutation change                      |
| `captureDelay`               | `200`            | Delay (ms) before capture after `done()` / `doneAfter`                                |
| `password`                   | -                | Shared secret for deep link validation                                                |

### CLI flags

```bash
bunx snapscene <config.json> [options]

  --debug              Verbose logging in runner and app
  --screen home,game   Only run these scenarios (comma-separated)
  --device "iPhone 16" Only run on these devices (comma-separated)
  --<matrix-key> val   Override matrix values (e.g. --locale en,de)
```

### Permutation changes

When `killBetweenPermutations` is `false` and the matrix changes (e.g. switching from `locale: "en"` to `locale: "de"`), the runner sends a special deep link that re-runs your `globalSetup` with the new params. Set `waitAfterPermutationChange` if async side-effects need time to settle.

When `killBetweenPermutations` is `true` (the default), the app is killed and relaunched for each permutation.

### Password protection

Screenshot setup callbacks often grant elevated access — simulating purchases, unlocking premium content. Without a password, anyone who knows your URL scheme could trigger this on a real device.

Set a shared password in both `configure()` and the runner config:

```ts
configure<Store>({
  password: "s3cret",
  globalSetup: ({ ctx }) => {
    ctx.dispatch(simulateIAP());
  },
});
```

```json
{
  "password": "s3cret"
}
```

The runner includes the password in the deep link. The app-side hook rejects any deep link where the password doesn't match.
