import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allPolicies } from "../src/policy/policies";

/**
 * docs/control-mapping.md must not drift from the suite, in either direction.
 *
 * A mapping document that has drifted is worse than no document, because it
 * reads as proof. Reviewing it by eye is exactly the check that stops happening
 * once the table gets long, so it is checked here instead.
 */

const repoRoot = join(__dirname, "..", "..", "..");
const testRoot = join(__dirname);
const MAPPING = join(repoRoot, "docs", "control-mapping.md");

interface MappingRow {
  readonly id: string;
  readonly source: string;
  readonly policyRule: string;
}

/** Parses the control table. Rows are `| CR-0X | … | source | … | … | rule |`. */
const rows = (): MappingRow[] =>
  readFileSync(MAPPING, "utf-8")
    .split("\n")
    .filter((line) => /^\|\s*CR-\d{2}\s*\|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((c) => c.trim());
      // cells[0] is the empty string before the leading pipe.
      return { id: cells[1], source: cells[3], policyRule: cells[6] };
    });

/** Every control id appearing in a `describe` or `it` title, across the suite. */
const controlIdsInTests = (): Set<string> => {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      // This file is the checker, not a control test. Scanning it would find
      // the control ids in its own expected-ids array and conclude every
      // control is tested — making the "no row without a test" check incapable
      // of failing. Caught by mutation-testing that check, not by review.
      if (!entry.endsWith(".test.ts") || entry === "control-mapping.test.ts") {
        continue;
      }
      for (const match of readFileSync(path, "utf-8").matchAll(/"(CR-\d{2})[^"]*"/g)) {
        found.add(match[1]);
      }
      // "CR-01/CR-03: ..." names two controls in one title.
      for (const match of readFileSync(path, "utf-8").matchAll(/\/(CR-\d{2})/g)) {
        found.add(match[1]);
      }
    }
  };
  walk(testRoot);
  return found;
};

describe("control mapping completeness", () => {
  it("documents nine controls, numbered contiguously from one", () => {
    const ids = rows().map((r) => r.id);
    expect(ids).toHaveLength(9);
    // Derived, not restated: a literal list here would reintroduce the control
    // ids into this file and break the scanner that excludes it.
    expect(ids).toEqual(
      Array.from({ length: 9 }, (_, i) => `CR-0${String(i + 1)}`),
    );
  });

  it("has no row without a test — a control nothing proves is not a control", () => {
    const tested = controlIdsInTests();
    const undocumented = rows().map((r) => r.id).filter((id) => !tested.has(id));
    expect(undocumented).toEqual([]);
  });

  it("has no control test without a row — a proven control nobody recorded", () => {
    const documented = new Set(rows().map((r) => r.id));
    const unmapped = [...controlIdsInTests()].filter((id) => !documented.has(id)).toSorted();
    expect(unmapped).toEqual([]);
  });
});

describe("control mapping accuracy", () => {
  it("names only policy rules that exist in the pack", () => {
    const real = new Set(allPolicies.map((p) => p.name));
    const named = rows().map((r) => r.policyRule).filter((rule) => rule !== "—" && rule !== "");
    for (const rule of named) {
      expect(real, rule).toContain(rule.replaceAll("`", ""));
    }
  });

  it("references every rule the pack actually ships", () => {
    // The other direction: a rule nobody documented is a rule nobody reviews.
    const named = rows()
      .map((r) => r.policyRule.replaceAll("`", ""))
      .filter((rule) => rule !== "—" && rule !== "");
    for (const policy of allPolicies) {
      expect(named, policy.name).toContain(policy.name);
    }
  });

  it("cites a source for every control", () => {
    for (const row of rows()) {
      expect(row.source.length, row.id).toBeGreaterThan(10);
      expect(row.source, row.id).toContain("https://");
    }
  });

  it("makes no CIS citation without a benchmark version and control number", () => {
    // The rule the spec sets: no control ID inferred from subject matter. v1
    // cites Google throughout, so any CIS mention appearing later must carry
    // both a version and a numbered control.
    for (const row of rows()) {
      if (/CIS/i.test(row.source)) {
        expect(row.source, `${row.id} cites CIS`).toMatch(/v\d/);
        expect(row.source, `${row.id} cites CIS`).toMatch(/\d+\.\d+/);
      }
    }
  });
});
