/**
 * Property-based tests for the Line-Anchor Re-anchoring sub-component
 * (Design Component 9, CC9).
 *
 * Feature: codebase-modernization-refresh, Property 9
 *
 * Property 9: Line-anchor correctness after arbitrary edits
 * Validates: Requirements 11.1, 11.2
 *
 * Given an arbitrary source file that contains a uniquely-identifiable target
 * region marker, after arbitrary edits that insert/delete lines ABOVE and BELOW
 * the marker (without removing the marker), `reanchorAnchor` MUST resolve the
 * anchor to the marker's NEW, correct 1-based line — i.e. the resolved line
 * ALWAYS equals the marker's actual current 1-based line in the edited content,
 * with status `updated` or `unchanged` as appropriate (Req 11.1, 11.2).
 *
 * Conversely, when the marker is removed entirely, the anchor is reported
 * `unresolved` and left otherwise unchanged (Req 11.5 — the contrapositive that
 * makes the re-anchoring sound).
 *
 * The oracle is the marker's actual index in the generated line array, computed
 * INDEPENDENTLY of the module under test, so the property is a genuine
 * cross-check rather than a tautology.
 */
import fc from 'fast-check';
import { reanchorAnchor } from './lineAnchorReanchorer';
import type { LineAnchor } from './models';

/**
 * A unique, stable target-region marker. It contains `@@`, a sequence the
 * generated filler lines can never produce (every `@` is stripped below), so
 * the marker is guaranteed to occur exactly once in any assembled content.
 */
const MARKER = '@@TARGET_REGION_MARKER@@';

/**
 * Arbitrary filler line that is guaranteed NOT to contain {@link MARKER}:
 * stripping every `@` makes the `@@` sentinel impossible. Lengths include 0 so
 * empty lines are exercised too.
 */
const fillerLineArb = fc
  .string({ minLength: 0, maxLength: 24 })
  .map((s) => s.replace(/@/g, 'a'));

/** An arbitrary block of filler lines (models arbitrary insert/delete edits). */
const fillerBlockArb = fc.array(fillerLineArb, { minLength: 0, maxLength: 40 });

function makeAnchor(recordedLine: number): LineAnchor {
  return {
    workshopFile: 'content/lab01/index.en.md',
    anchorKind: 'highlightLinesStart',
    sourceFile: 'lib/cell-management-system/CellStack.ts',
    recordedLine,
    targetRegionMarker: MARKER,
    status: 'unchanged',
  };
}

describe('Feature: codebase-modernization-refresh, Property 9 — Line-anchor correctness after arbitrary edits', () => {
  it('resolves the anchor to the marker\'s actual current 1-based line, with correct status (Req 11.1, 11.2)', () => {
    fc.assert(
      fc.property(
        fillerBlockArb, // arbitrary lines ABOVE the marker (net insert/delete)
        fillerBlockArb, // arbitrary lines BELOW the marker (net insert/delete)
        fc.integer({ min: 1, max: 60 }), // arbitrary previously-recorded line
        fc.boolean(), // sometimes force recordedLine == new line to exercise 'unchanged'
        (above, below, recordedLineRaw, matchRecorded) => {
          const lines = [...above, MARKER, ...below];
          const content = lines.join('\n');

          // Independent oracle: 1-based line of the marker = (# lines above) + 1.
          const expectedLine = above.length + 1;

          const recordedLine = matchRecorded ? expectedLine : recordedLineRaw;
          const result = reanchorAnchor(makeAnchor(recordedLine), content);

          // Req 11.2: resolved line ALWAYS equals the marker's current 1-based line.
          expect(result.resolvedLine).toBe(expectedLine);

          // Req 11.1: status reflects the comparison against the recorded line.
          if (recordedLine === expectedLine) {
            expect(result.status).toBe('unchanged');
          } else {
            expect(result.status).toBe('updated');
          }
          expect(result.status).not.toBe('unresolved');
        }
      ),
      { numRuns: 300 }
    );
  });

  it('edits BELOW the marker never shift the resolved line (only edits above matter) (Req 11.2)', () => {
    fc.assert(
      fc.property(
        fillerBlockArb, // shared lines ABOVE the marker
        fillerBlockArb, // one arbitrary below-block
        fillerBlockArb, // a different arbitrary below-block
        (above, belowA, belowB) => {
          const expectedLine = above.length + 1;
          const recordedLine = expectedLine; // baseline: anchor currently correct

          const resultA = reanchorAnchor(
            makeAnchor(recordedLine),
            [...above, MARKER, ...belowA].join('\n')
          );
          const resultB = reanchorAnchor(
            makeAnchor(recordedLine),
            [...above, MARKER, ...belowB].join('\n')
          );

          expect(resultA.resolvedLine).toBe(expectedLine);
          expect(resultB.resolvedLine).toBe(expectedLine);
          // Independent of whatever was inserted/deleted below the region.
          expect(resultA.resolvedLine).toBe(resultB.resolvedLine);
          expect(resultA.status).toBe('unchanged');
          expect(resultB.status).toBe('unchanged');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('reports unresolved and leaves the anchor unchanged when the marker is removed entirely (Req 11.5)', () => {
    fc.assert(
      fc.property(
        fillerBlockArb, // content with NO marker at all (region removed)
        fc.integer({ min: 1, max: 60 }),
        (lines, recordedLine) => {
          // Guard: the generated filler can never contain the marker.
          const content = lines.join('\n');
          fc.pre(!content.includes(MARKER));

          const input = makeAnchor(recordedLine);
          const result = reanchorAnchor(input, content);

          expect(result.status).toBe('unresolved');
          expect(result.resolvedLine).toBeUndefined();
          // Anchor left otherwise unchanged: recorded line and identifying fields preserved.
          expect(result.recordedLine).toBe(recordedLine);
          expect(result.targetRegionMarker).toBe(MARKER);
          expect(result.sourceFile).toBe(input.sourceFile);
          expect(result.workshopFile).toBe(input.workshopFile);
          // The input object itself is never mutated.
          expect(input.resolvedLine).toBeUndefined();
          expect(input.status).toBe('unchanged');
        }
      ),
      { numRuns: 200 }
    );
  });
});
