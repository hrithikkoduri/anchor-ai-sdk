/**
 * The batch's input: phases of ordered ops, parsed from the model's untrusted
 * JSON into typed units. Pure — no sandbox, no tools — so the shape rules are
 * tested on their own.
 *
 * A read with `paths` expands into one unit per path that shares the op's
 * number (`#1 read a.ts`, `#1 read b.ts`); every unit counts toward the cap,
 * so `paths` cannot smuggle in more work than the op limit allows.
 */

export const BATCH_MAX_OPS = 20;

export type BatchUnit =
  | { op: "read"; index: number; path: string; offset?: number; limit?: number }
  | { op: "search"; index: number; pattern: string; path?: string; glob?: string; regex?: boolean }
  | { op: "bash"; index: number; command: string; repository?: string; timeoutSecs?: number }
  | { op: "edit"; index: number; path: string; old: string; new: string; replaceAll: boolean }
  | { op: "write"; index: number; path: string; content: string }
  /** An op the batch could not parse: reported on its own, never run. */
  | { op: "invalid"; index: number; name: string; target: string; error: string };

export type BatchOpName = BatchUnit["op"];

/** Ops that can change the workspace: a phase holding one runs in order. */
export const WRITING_OPS: ReadonlySet<BatchOpName> = new Set(["bash", "edit", "write"]);

export interface BatchPhase {
  units: BatchUnit[];
  /** Reads and searches only: its units may run concurrently. */
  concurrent: boolean;
}

export interface ParsedBatch {
  phases: BatchPhase[];
  stopOnError: boolean;
  /** Number of ops (not units) — the `#n` labels run 1..ops. */
  ops: number;
  units: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const int = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : undefined;
};

function parseOp(raw: unknown, index: number): BatchUnit[] {
  if (!isRecord(raw)) return [{ op: "invalid", index, name: "?", target: "", error: "an op must be an object with an \"op\" field" }];
  const target = str(raw.path) ?? str(raw.command) ?? str(raw.pattern) ?? "";
  const fail = (name: string, error: string): BatchUnit[] => [{ op: "invalid", index, name, target, error }];
  const name = typeof raw.op === "string" ? raw.op : "?";
  switch (name) {
    case "read": {
      const paths = Array.isArray(raw.paths)
        ? raw.paths.filter((item): item is string => typeof item === "string" && item.trim() !== "")
        : [];
      const single = str(raw.path);
      const all = single ? [single, ...paths] : paths;
      if (all.length === 0) return fail(name, "read needs \"path\" or a non-empty \"paths\"");
      const offset = int(raw.offset);
      const limit = int(raw.limit);
      return all.map((path) => ({
        op: "read" as const,
        index,
        path,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }));
    }
    case "search": {
      const pattern = str(raw.pattern);
      if (!pattern) return fail(name, "search needs a non-empty \"pattern\"");
      const path = str(raw.path);
      const glob = str(raw.glob);
      return [
        {
          op: "search",
          index,
          pattern,
          ...(path ? { path } : {}),
          ...(glob ? { glob } : {}),
          ...(raw.regex === true ? { regex: true } : {}),
        },
      ];
    }
    case "bash": {
      const command = str(raw.command);
      if (!command) return fail(name, "bash needs a non-empty \"command\"");
      const repository = str(raw.repository);
      const timeoutSecs = int(raw.timeout_secs);
      return [
        {
          op: "bash",
          index,
          command,
          ...(repository ? { repository } : {}),
          ...(timeoutSecs !== undefined && timeoutSecs > 0 ? { timeoutSecs } : {}),
        },
      ];
    }
    case "edit": {
      const path = str(raw.path);
      if (!path) return fail(name, "edit needs \"path\"");
      if (typeof raw.old !== "string" || raw.old === "") return fail(name, "edit needs a non-empty \"old\"");
      if (typeof raw.new !== "string") return fail(name, "edit needs \"new\" (a string; may be empty)");
      return [{ op: "edit", index, path, old: raw.old, new: raw.new, replaceAll: raw.replaceAll === true }];
    }
    case "write": {
      const path = str(raw.path);
      if (!path) return fail(name, "write needs \"path\"");
      if (typeof raw.content !== "string") return fail(name, "write needs \"content\" (a string)");
      return [{ op: "write", index, path, content: raw.content }];
    }
    default:
      return fail(name, `unknown op "${name}" — use read, search, bash, edit or write`);
  }
}

/**
 * Parse the batch input. Structural problems (no ops, too many, both `ops`
 * and `phases`) fail the whole call; a single malformed op becomes an
 * `invalid` unit that reports on its own while the rest run.
 */
export function parseBatch(input: Record<string, unknown>): ParsedBatch | { error: string } {
  const hasPhases = input.phases !== undefined;
  const hasOps = input.ops !== undefined;
  if (hasPhases && hasOps) return { error: "pass either \"phases\" or \"ops\", not both" };
  let rawPhases: unknown[];
  if (hasPhases) {
    if (!Array.isArray(input.phases)) return { error: "\"phases\" must be an array of { ops: [...] }" };
    rawPhases = input.phases;
  } else if (hasOps) {
    rawPhases = [{ ops: input.ops }];
  } else {
    return { error: "a batch needs \"phases\" (or a flat \"ops\" list)" };
  }

  const phases: BatchPhase[] = [];
  let index = 0;
  let units = 0;
  for (const rawPhase of rawPhases) {
    const ops = isRecord(rawPhase) ? rawPhase.ops : undefined;
    if (!Array.isArray(ops)) return { error: "every phase must be an object with an \"ops\" array" };
    const phaseUnits: BatchUnit[] = [];
    for (const raw of ops) {
      index += 1;
      phaseUnits.push(...parseOp(raw, index));
    }
    units += phaseUnits.length;
    if (phaseUnits.length > 0)
      phases.push({
        units: phaseUnits,
        concurrent: phaseUnits.every((unit) => !WRITING_OPS.has(unit.op)),
      });
  }
  if (units === 0) return { error: "the batch has no ops" };
  if (units > BATCH_MAX_OPS)
    return {
      error: `a batch holds at most ${BATCH_MAX_OPS} ops (each path of a read counts); this one has ${units} — split it`,
    };
  return { phases, stopOnError: input.stopOnError === true, ops: index, units };
}
