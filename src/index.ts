/**
 * anchor-ai-sdk — the public API.
 *
 * Loop-first, sandbox-first agent framework: an LLM transport, a sandbox
 * abstraction with pluggable backends, a tool protocol with a coding tool
 * set, and (step 7) the engine that runs it all.
 *
 * Publishable-ready rules (decision #16): nothing here reads environment
 * variables or imports product infrastructure — consumer applications own
 * configuration and orchestration.
 */
export * from "./json.js";
export * from "./repo.js";
export * from "./skills/index.js";
export * from "./teams/index.js";
export * from "./llm/index.js";
export * from "./llm/from-catalog.js";
export * from "./anchor.js";
export * from "./sandbox/index.js";
export * from "./tools/index.js";
export * from "./ledger/index.js";
export * from "./verify/index.js";

// Engine — the loop mechanics (strategy-agnostic)
export * from "./engine/budgets.js";
export * from "./engine/compaction.js";
export * from "./engine/events.js";
export * from "./engine/evidence.js";
export * from "./engine/revival.js";
export * from "./engine/snapshot.js";
export * from "./engine/thread.js";
export * from "./engine/inbox.js";
export * from "./engine/operations.js";
export * from "./engine/strategy.js";
export { runAgent, userTurn } from "./engine/loop.js";
export type {
  RunInput,
  EngineOptions,
  AgentResult,
  FinishReason,
  GuardrailConfig,
} from "./engine/loop.js";

// Trace — durable run records (redaction + NDJSON)
export * from "./trace/conversation.js";
export * from "./trace/jsonl.js";
export * from "./trace/live-projector.js";
export * from "./trace/redact.js";
export * from "./trace/sink.js";

// Agents — built-in bundles: strategy + tools in one import (codingAgent, chatAgent)
export * from "./agents/index.js";
