export { default } from "./extensions/index";
export * from "./extensions/index";

// Public helper APIs for other extensions/packages.
export * from "./helpers/index";

// Trace context utilities (env + session entry helpers).
export * from "./lib/trace-env";

// Global registries (advanced interop).
export * from "./extensions/runtime-registry";
export * from "./extensions/span-context-registry";
