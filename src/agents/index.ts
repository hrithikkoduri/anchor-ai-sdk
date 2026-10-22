/**
 * Built-in agents — each a strategy + tools bundle (see ./types.ts).
 *
 * Import one and hand it to the engine:
 *   runAgent(task, { llm, agent: codingAgent });
 */
export * from "./types.js";
export * from "./coding/index.js";
export * from "./chat/index.js";
export * from "./terminal/index.js";
