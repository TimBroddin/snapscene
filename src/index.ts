export { registerScreenshotScenario, configure } from "./registry";
export { useScreenshot } from "./hook";
export type { UseScreenshotResult } from "./hook";
export { useScreenshotDeepLink } from "./useScreenshotDeepLink";
export { getState as getScreenshotState, activate, deactivate } from "./state";
export type { ScreenshotContext, ScenarioDefinition } from "./registry";
