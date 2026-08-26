import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The EP rows of docs/control-mapping.md must not drift from this suite, in
 * either direction. Same guarantee as gcp-components' checker, scoped to this
 * package's prefix — the document is shared; the proof is per-package.
 *
 * Unlike that checker, contiguity-from-one is not asserted: EP ids are
 * assigned by SPEC-environment-provisioning.md, all seven up front, and rows
 * accrete as the E-series lands. What is asserted instead is that every row
 * is one of the spec's seven. The E5 checkpoint tightens this to "all seven
 * present".
 */

const repoRoot = join(__dirname, "..", "..", "..");
const MAPPING = join(repoRoot, "docs", "control-mapping.md");

/** The controls the spec defines. A row outside this set is a typo. */
const SPEC_CONTROLS = new Set(
  Array.from({ length: 7 }, (_, i) => `EP-${String(i + 1).padStart(2, "0")}`),
);

interface MappingRow {
  readonly id: string;
  readonly source: string;
}

const rows = (): MappingRow[] =>
  readFileSync(MAPPING, "utf-8")
    .split("\n")
    .filter((line) => /^\|\s*EP-\d{2}\s*\|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((c) => c.trim());
      return { id: cells[1], source: cells[3] };
    });

/** Every EP id claimed by a test title in this suite, by the same regexes the
 * gcp-components scanner uses — a title claiming an id is claiming the proof. */
const controlIdsInTests = (): Set<string> => {
  const found = new Set<string>();
  for (const entry of readdirSync(__dirname)) {
    // This file is the checker, not a control test: scanning it would find
    // the ids in SPEC_CONTROLS and conclude everything is tested.
    if (!entry.endsWith(".test.ts") || entry === "control-mapping.test.ts") {
      continue;
    }
    const content = readFileSync(join(__dirname, entry), "utf-8");
    for (const match of content.matchAll(/"(EP-\d{2})[^"]*"/g)) {
      found.add(match[1]);
    }
    for (const match of content.matchAll(/\/(EP-\d{2})/g)) {
      found.add(match[1]);
    }
  }
  return found;
};

describe("EP control mapping completeness", () => {
  it("names only controls the spec defines, each at most once", () => {
    const ids = rows().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(SPEC_CONTROLS, id).toContain(id);
    }
  });

  it("has no row without a test — a control nothing proves is not a control", () => {
    const tested = controlIdsInTests();
    const unproven = rows().map((r) => r.id).filter((id) => !tested.has(id));
    expect(unproven).toEqual([]);
  });

  it("has no control test without a row — a proven control nobody recorded", () => {
    const documented = new Set(rows().map((r) => r.id));
    const unmapped = [...controlIdsInTests()].filter((id) => !documented.has(id)).toSorted();
    expect(unmapped).toEqual([]);
  });

  it("cites a source for every control", () => {
    expect(rows().length).toBeGreaterThan(0);
    for (const row of rows()) {
      expect(row.source, row.id).toContain("https://");
    }
  });
});
