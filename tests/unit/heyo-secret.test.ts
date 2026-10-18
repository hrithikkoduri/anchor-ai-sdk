/**
 * The Heyo secret upsert — a client double stands in for the SDK. The spec
 * must be exactly {id, namespace, data}: the host-side git build reads its
 * clone credential from the store, and this is the only way it gets there.
 */
import { describe, expect, it } from "vitest";
import { upsertHeyoSecret } from "../../src/sandbox/heyo-secret.js";

describe("upsertHeyoSecret", () => {
  it("puts the value under the configured secret + key", async () => {
    let seen: unknown;
    await upsertHeyoSecret({
      server: "https://admin.us5.heyo.work",
      token: "applb_test",
      namespace: "harness",
      secret: "heyo-build-git",
      key: "git-token",
      value: "ghs_fresh",
      client: {
        putSecret: async (spec) => {
          seen = spec;
          return {} as never;
        },
      },
    });
    expect(seen).toEqual({
      id: "heyo-build-git",
      namespace: "harness",
      data: { "git-token": "ghs_fresh" },
    });
  });

  it("propagates a failure so the caller can choose its fallback", async () => {
    await expect(
      upsertHeyoSecret({
        server: "https://admin.us5.heyo.work",
        token: "t",
        namespace: "harness",
        secret: "s",
        key: "k",
        value: "v",
        client: {
          putSecret: async () => {
            throw new Error("403 denied");
          },
        },
      }),
    ).rejects.toThrow(/403/);
  });
});
