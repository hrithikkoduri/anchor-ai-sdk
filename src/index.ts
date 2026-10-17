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

// Engine — the loop mechanics (strategy-agnostic)
export * from "./engine/budgets.js";
export * from "./engine/compaction.js";
export * from "./engine/events.js";
export * from "./engine/session.js";
export * from "./engine/strategy.js";
export { runAgent } from "./engine/loop.js";
export type { RunTask, EngineOptions, AgentResult, FinishReason } from "./engine/loop.js";

// Trace — durable run records (redaction + NDJSON)
export * from "./trace/jsonl.js";
export * from "./trace/redact.js";

// Strategies — the behaviors we ship (coding is the default agent)
export { codingStrategy } from "./strategies/coding.js";
