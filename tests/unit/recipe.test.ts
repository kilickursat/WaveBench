import { describe, expect, it } from "vitest";
import { parseRecipe, recipeConfig, RECIPE_SCHEMA, RecipeError } from "../../apps/web/src/lib/recipe";
import type { SourceInfo } from "../../apps/web/src/engine/protocol";
import { repoFile } from "./helpers";

const rawSource: SourceInfo = {
  name: "acceleration-raw.csv", bytes: 378593, sha256: null, kind: "file", names: ["ax_g", "ay_g", "az_g"],
  kinds: ["number", "number", "number"], rowCount: 8192, timeOrigins: [null, null, null], issues: [], issueCount: 0,
  columnIssueCounts: [0, 0, 0], rowsWithIssues: 0, skippedCommentLines: 0, skippedBlankLines: 0, parseOptions: null,
  generator: null, parseMs: 0,
};

describe("analysis recipes", () => {
  const example = JSON.parse(repoFile("examples/example.recipe.json"));

  it("the bundled example recipe is valid and names its input by hash", () => {
    const r = parseRecipe(example);
    expect(r.schema).toBe(RECIPE_SCHEMA);
    expect(r.record.timebase).toEqual({ mode: "rate", sampleRateHz: 1024, startSec: 0 });
    const manifest = JSON.parse(repoFile("reference/manifest.json"));
    expect(r.input.sha256).toBe(manifest.filesSha256["examples/acceleration-raw.csv"]);
  });

  it("maps onto a file with the same column names", () => {
    const { config, missing } = recipeConfig(parseRecipe(example), rawSource);
    expect(missing).toEqual([]);
    expect(config!.channels.map((c) => c.column)).toEqual([0, 1, 2]);
    expect(config!.unit).toBe("g");
  });

  it("reports columns a different file does not have", () => {
    const other = { ...rawSource, names: ["ax_g", "q", "r"] };
    const { config, missing } = recipeConfig(parseRecipe(example), other);
    expect(missing).toEqual(["ay_g", "az_g"]);
    expect(config!.channels).toHaveLength(1);
  });

  it("refuses other schemas and broken structure", () => {
    expect(() => parseRecipe({ ...example, schema: "0.1-draft" })).toThrow(RecipeError);
    expect(() => parseRecipe({ ...example, record: { ...example.record, timebase: { mode: "rate", sampleRateHz: -5 } } })).toThrow(RecipeError);
    expect(() => parseRecipe([])).toThrow(RecipeError);
  });
});
