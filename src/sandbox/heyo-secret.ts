/**
 * Heyo admin plumbing the sandbox layer needs beyond deployment lifecycle:
 * upserting namespace secrets.
 *
 * The store is how host-side machinery — image builds in particular — reads
 * credentials, and a stored value can go stale (an installation token lives
 * an hour). Callers mint a fresh value on their own schedule; this function is
 * the mechanics only. Policy (when, whether, best-effort) stays with them.
 *
 * Note: values enter the store and are never readable back out.
 */
import { Hws } from "@heyocomputer/hws";

export interface UpsertHeyoSecretArgs {
  server: string;
  token: string;
  namespace: string;
  secret: string;
  key: string;
  value: string;
  /** Test seam: a client double. Defaults to a real client on `server`. */
  client?: Pick<Hws, "putSecret">;
}

export async function upsertHeyoSecret(
  args: UpsertHeyoSecretArgs,
): Promise<void> {
  const lb = args.client ?? new Hws({ server: args.server, token: args.token });
  await lb.putSecret({
    id: args.secret,
    namespace: args.namespace,
    data: { [args.key]: args.value },
  });
}
