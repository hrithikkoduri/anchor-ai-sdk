/**
 * @anchor/core — the public API.
 *
 * Loop-first, sandbox-first agent framework: an LLM transport, a sandbox
 * abstraction with pluggable backends, a tool protocol with a coding tool
 * set, and (step 7) the engine that runs it all.
 *
 * Publishable-ready rules (decision #16): nothing here reads environment
 * variables or imports product infrastructure — consumers like apps/server
 * own configuration and orchestration.
 */
export * from "./llm/index.js";
export * from "./llm/from-catalog.js";
export * from "./sandbox/index.js";
export * from "./tools/index.js";

// Engine — the loop mechanics (strategy-agnostic)
export * from "./engine/budgets.js";
export * from "./engine/compaction.js";
export * from "./engine/events.js";
export * from "./engine/thread.js";
export * from "./engine/strategy.js";
export { runAgent } from "./engine/loop.js";
export type {
  RunTask,
  EngineOptions,
  AgentResult,
  FinishReason,
  GuardrailConfig,
} from "./engine/loop.js";

// Trace — durable run records (redaction + NDJSON)
export * from "./trace/jsonl.js";
export * from "./trace/redact.js";

// Agents — built-in bundles: strategy + tools in one import (codingAgent, chatAgent)
export * from "./agents/index.js";
