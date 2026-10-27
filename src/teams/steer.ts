/**
 * Steering: the leader's directives to a RUNNING delegated child.
 *
 * A child's `delegate` call blocks the leader's model turn, so the leader
 * cannot intervene from inside its own loop. The two seams are the same
 * channel: the host reacts to `onProgress` and calls the handle there, and a
 * `steer_worker` tool exposes the same push to the leader's model. Both are
 * bounded, length-capped, and delivered as an ordinary user message labelled
 * `[from the leader] …` at the child's next turn boundary — never as a tool
 * result, so a directive cannot forge evidence about a tool.
 */

/** Most directives one child accepts over its whole run. */
export const STEER_MAX_PER_CHILD = 5;

/** Longest directive accepted; longer text is truncated, not rejected. */
export const STEER_MAX_CHARS = 500;

/**
 * One child's steering channel. The parent end `push`es; the child end
 * `drain`s at each turn boundary. Shared deliberately: it is the only state
 * that crosses the two loops.
 */
export interface SteerChannel {
  /** Queue one directive; false when the cap is reached or the child ended. */
  push(text: string): boolean;
  /** Take everything queued since the last drain, oldest first. */
  drain(): string[];
  /** Close the channel when the child ends; every later push is refused. */
  close(): void;
  /** How many directives have been accepted. */
  readonly used: number;
  /** The cap this channel enforces. */
  readonly limit: number;
  /** True once the child has finished. */
  readonly closed: boolean;
}

/** Collapse whitespace and cap the length; an empty directive is refused. */
export function normalizeDirective(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > STEER_MAX_CHARS
    ? collapsed.slice(0, STEER_MAX_CHARS)
    : collapsed;
}

/** The message the child's model sees. Clearly the leader's, never a result. */
export function steerDirective(text: string): string {
  return `[from the leader] ${text}`;
}

export function createSteerChannel(limit = STEER_MAX_PER_CHILD): SteerChannel {
  const queued: string[] = [];
  let used = 0;
  let closed = false;
  return {
    push(text: string): boolean {
      if (closed) return false;
      const directive = normalizeDirective(text);
      if (!directive || used >= limit) return false;
      used += 1;
      queued.push(directive);
      return true;
    },
    drain(): string[] {
      return queued.splice(0, queued.length);
    },
    close(): void {
      closed = true;
      queued.length = 0;
    },
    get used() {
      return used;
    },
    get limit() {
      return limit;
    },
    get closed() {
      return closed;
    },
  };
}
