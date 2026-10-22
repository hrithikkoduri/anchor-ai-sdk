/**
 * Threads — cross-run conversation memory, the generic capability.
 *
 * A run forgets everything when it ends, unless the caller supplies a
 * `ThreadStore`: the engine loads the prior conversation before the first LLM
 * call and saves the updated conversation when the run ends. That single
 * mechanism is what turns "one agent run" into a chat agent, a research
 * thread, or the issue→PR product's multi-run continuity.
 *
 * The framework defines the shape; the consumer supplies the notebook:
 *   - `MemoryThreadStore` (here): zero-dependency default for tests and demos
 *   - a product-grade one: `PostgresThreadStore` in the app (step 11)
 *   - strangers: SQLite, Redis, files — their call
 * The package never depends on a database.
 *
 * ("Checkpointer" — LangGraph's vocabulary — is the same concept: conversation
 * state saved at boundaries so runs can continue or resume. Our git-commit
 * sandbox checkpoints are the workspace-side counterpart.)
 */
import type { LLMMessage } from "../llm/types.js";
import type { ProgressLedger } from "../ledger/types.js";

export interface StoredThread {
  /** Running summary of earlier, compacted turns (compaction maintains this). */
  summary?: string;
  /** Verbatim recent conversation (no system message; the engine adds a fresh one each run). */
  messages: LLMMessage[];
  /**
   * The phase the thread is currently in. Resume (pause or crash recovery)
   * starts the next run here instead of at the first phase.
   */
  phase?: string;
  /** Durable task contract + evidence references; owned by the SDK. */
  ledger?: ProgressLedger;
}

export interface ThreadStore {
  load(threadId: string): Promise<StoredThread | undefined>;
  /** Replace the thread's stored state (implementations overwrite, not append). */
  save(threadId: string, thread: StoredThread): Promise<void>;
}

/** In-memory implementation — clones on the way in and out so callers can't mutate stored state. */
export class MemoryThreadStore implements ThreadStore {
  private readonly data = new Map<string, StoredThread>();

  async load(threadId: string): Promise<StoredThread | undefined> {
    const thread = this.data.get(threadId);
    return thread === undefined ? undefined : structuredClone(thread);
  }

  async save(threadId: string, thread: StoredThread): Promise<void> {
    this.data.set(threadId, structuredClone(thread));
  }
}
