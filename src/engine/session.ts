/**
 * Cross-run memory — the thread capability of the framework.
 *
 * A run forgets everything when it ends, unless the caller supplies a
 * `SessionStore`: the engine loads the prior conversation before the first
 * LLM call and saves the updated conversation when the run ends. That single
 * mechanism is what turns "one agent run" into a chat agent, a research
 * thread, or the issue→PR product's multi-run continuity.
 *
 * The framework defines the shape; the consumer supplies the notebook:
 *   - `MemoryStore` (here): zero-dependency default for tests and demos
 *   - `PostgresSessionStore` (apps/harness): our product's durable storage
 *   - strangers: SQLite, Redis, files — their call
 * The package never depends on a database.
 */
import type { LLMMessage } from "../llm/types.js";

export interface StoredSession {
  /** Running summary of earlier, compacted turns (compaction lands in step 19). */
  summary?: string;
  /** Verbatim recent conversation (no system message; the engine adds a fresh one each run). */
  messages: LLMMessage[];
}

export interface SessionStore {
  load(sessionId: string): Promise<StoredSession | undefined>;
  /** Replace the session's stored state (implementations overwrite, not append). */
  save(sessionId: string, session: StoredSession): Promise<void>;
}

/** In-memory implementation — clones on the way in and out so callers can't mutate stored state. */
export class MemoryStore implements SessionStore {
  private readonly data = new Map<string, StoredSession>();

  async load(sessionId: string): Promise<StoredSession | undefined> {
    const session = this.data.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  async save(sessionId: string, session: StoredSession): Promise<void> {
    this.data.set(sessionId, structuredClone(session));
  }
}
