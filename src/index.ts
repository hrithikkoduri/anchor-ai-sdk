/**
 * @harness/agent — the public API.
 *
 * Loop-first, sandbox-first agent framework: an LLM transport, a sandbox
 * abstraction with pluggable backends, a tool protocol with a coding tool
 * set, and (step 7) the engine that runs it all.
 *
 * Publishable-ready rules (decision #16): nothing here reads environment
 * variables or imports product infrastructure — consumers like apps/harness
 * own configuration and orchestration.
 */
export * from "./llm/index.js";
export * from "./sandbox/index.js";
export * from "./tools/index.js";
