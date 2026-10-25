import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
// Comments are stripped first, so one explaining why we never call follow() cannot trip it.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sources = readdirSync(SRC)
  .filter((fileName) => fileName.endsWith(".ts"))
  .map((fileName) => ({
    file: fileName,
    body: stripComments(readFileSync(`${SRC}${fileName}`, "utf8")),
  }));

describe("project invariants", () => {
  it("never follows anyone on its own", () => {
    // A following bot would see followers-only posts and could leak them into a public image.
    // The only follow() is the operator's `node ace follow`, gated on TESTING_MODE.
    for (const { file, body } of sources) {
      if (file === "cli.ts") {
        const guard = body.indexOf("if (!cfg.testingMode)");
        const follow = body.search(/\.follow\s*\(/);
        assert.ok(
          guard >= 0 && follow > guard,
          "cli.ts must check testingMode before follow()",
        );
        continue;
      }
      assert.equal(
        /\.follow\s*\(/.test(body),
        false,
        `${file} calls follow(); see PRIVACY.md before changing this`,
      );
    }
  });

  it("never writes SQL by hand", () => {
    // Tables come from Lucid migrations, queries from Lucid's builder in db.ts. Fedify and
    // BotKit run SQL inside their packages; our code, migrations and tests have none.
    const MIGRATIONS = fileURLToPath(new URL("../database/migrations/", import.meta.url));
    const migrations = readdirSync(MIGRATIONS).map((fileName) => ({
      file: `database/migrations/${fileName}`,
      body: stripComments(readFileSync(`${MIGRATIONS}${fileName}`, "utf8")),
    }));
    const TESTS = fileURLToPath(new URL("./", import.meta.url));
    const tests = readdirSync(TESTS)
      .filter((fileName) => fileName.endsWith(".ts") && fileName !== "invariants.test.ts")
      .map((fileName) => ({
        file: `test/${fileName}`,
        body: stripComments(readFileSync(`${TESTS}${fileName}`, "utf8")),
      }));
    const SQL =
      /\b(SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE TABLE|ALTER TABLE|PRAGMA)\b/;
    // Not .exec(): RegExp and Ace use that name; an .exec() with SQL hits the keyword check.
    const RAW = /\.(prepare|raw|knexRawQuery)\s*\(/;
    for (const { file, body } of [...sources, ...migrations, ...tests]) {
      assert.equal(SQL.test(body), false, `${file} contains SQL; use Lucid in db.ts instead`);
      assert.equal(RAW.test(body), false, `${file} runs a raw statement; use Lucid in db.ts`);
    }
  });

  it("talks to the database only from db.ts", () => {
    for (const { file, body } of sources) {
      if (file === "db.ts") continue;
      assert.equal(
        body.includes("@adonisjs/lucid"),
        false,
        `${file} imports Lucid; add a named function to db.ts instead`,
      );
    }
  });

  it("does not pass a Node flag that Node 26 removed", () => {
    // Node 26 refuses to start with --experimental-transform-types. The Dockerfile comment
    // that mentions it is not a command, hence the filter.
    const scripts = Object.values(
      JSON.parse(
        readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
      ).scripts as Record<string, string>,
    );
    const dockerCommands = readFileSync(
      fileURLToPath(new URL("../Dockerfile", import.meta.url)),
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    for (const line of [...scripts, ...dockerCommands]) {
      assert.equal(
        line.includes("--experimental-transform-types"),
        false,
        `"${line.trim()}" passes a flag Node 26 rejects outright`,
      );
    }
  });

  it("resolves exactly one copy of @fedify/fedify", () => {
    // With two copies, isActor() and `instanceof Image` compare different classes and return
    // false: actors fail to resolve and attachments vanish, with no error anywhere.
    const lock = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package-lock.json", import.meta.url)), "utf8"),
    ) as { packages: Record<string, { version?: string }> };
    const versions = new Set(
      Object.entries(lock.packages)
        .filter(([path]) => path.endsWith("node_modules/@fedify/fedify"))
        .map(([, meta]) => meta.version),
    );
    assert.equal(versions.size, 1, `found @fedify/fedify ${[...versions].join(", ")}`);
  });

  it("keeps stats.ts pure", () => {
    const stats = sources.find((source) => source.file === "stats.ts")!.body;
    assert.equal(
      /from "\.\/(config|db|outbox|tiles|strings)\.ts"/.test(
        stats.replace(/import type[^;]+;/g, ""),
      ),
      false,
      "stats.ts must not import project modules at runtime",
    );
    assert.equal(/Date\.now\(\)/.test(stats), false, "stats.ts must take its clock as input");
  });
});
