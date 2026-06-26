import { describe, expect, it } from "vitest";
import { formatPlanFeatures, parsePlanFeatures } from "../src/services/plan_features";

describe("plan feature list parsing", () => {
  it("accepts human-friendly comma and newline separated input", () => {
    expect(parsePlanFeatures("import_vrm, import_dance\nimport_stage")).toEqual([
      "import_vrm",
      "import_dance",
      "import_stage",
    ]);
  });

  it("accepts stored JSON arrays", () => {
    expect(parsePlanFeatures('["import_vrm","import_dance","import_stage"]')).toEqual([
      "import_vrm",
      "import_dance",
      "import_stage",
    ]);
  });

  it("repairs JSON text that was previously split by commas", () => {
    const malformed = '["[\\"import_vrm\\"","\\"import_dance\\"","\\"import_stage\\"]"]';

    expect(parsePlanFeatures(malformed)).toEqual([
      "import_vrm",
      "import_dance",
      "import_stage",
    ]);
    expect(formatPlanFeatures(malformed)).toBe("import_vrm, import_dance, import_stage");
  });

  it("deduplicates while preserving order", () => {
    expect(parsePlanFeatures("import_vrm, import_vrm, import_stage")).toEqual([
      "import_vrm",
      "import_stage",
    ]);
  });
});
