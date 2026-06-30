import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectCiCommand } from "./ci.js";

describe("detectCiCommand", () => {
  it("uses explicit override", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "twinpod-ci-"));
    await expect(detectCiCommand(repo, "make verify")).resolves.toBe("make verify");
  });

  it("detects package manager scripts as the full gate", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "twinpod-ci-"));
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", build: "tsc" } }),
      "utf8",
    );

    await expect(detectCiCommand(repo)).resolves.toBe("npm test && npm run lint && npm run build");
  });
});
