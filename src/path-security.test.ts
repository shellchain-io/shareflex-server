import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeResolveUnderRoot } from "./lib/movies.js";

describe("safeResolveUnderRoot", () => {
  it("allows nested paths under root", () => {
    const root = "/tmp/shareflex-media";
    const resolved = safeResolveUnderRoot(root, "movies", "abc", "master.m3u8");
    assert.equal(resolved, "/tmp/shareflex-media/movies/abc/master.m3u8");
  });

  it("rejects path traversal", () => {
    const root = "/tmp/shareflex-media";
    const resolved = safeResolveUnderRoot(root, "movies", "../../etc/passwd");
    assert.equal(resolved, null);
  });
});
