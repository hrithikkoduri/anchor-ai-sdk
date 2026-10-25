import { describe, expect, it } from "vitest";
import { repoByName } from "../../src/repo.js";

const repos = [
  { name: "acme/web", path: "web" },
  { name: "acme/api", path: "api" },
  { name: "other/api", path: "api-2" },
];

describe("repoByName", () => {
  it("takes the full name", () => {
    expect(repoByName(repos, "acme/api")?.path).toBe("api");
  });
  it("takes the short name when one repository has it", () => {
    expect(repoByName(repos, "web")?.path).toBe("web");
    expect(repoByName(repos, "Web")?.path).toBe("web");
  });
  it("leaves a short name two repositories share unresolved", () => {
    expect(repoByName(repos, "api")).toBeUndefined();
  });
});
