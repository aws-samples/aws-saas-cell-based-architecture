/**
 * Property-based tests for the engines / workshop-prerequisite consistency checker.
 *
 * Feature: codebase-modernization-refresh, Property 2
 *
 * Property 2: Node engines / workshop-prerequisite consistency
 * Validates: Requirements 3.2, 3.3
 *
 * Over arbitrary `(min, max, p)` inputs the checker MUST return "consistent" iff
 * the engines minimum equals the workshop prerequisite AND the prerequisite lies
 * within the declared range — i.e. `min === p` and `min <= p < max` (lower bound
 * inclusive, upper bound exclusive, matching the npm range form ">=<min> <<max>").
 * When inconsistent, the offending `package.json` path MUST be reported (Req 3.3).
 */
import fc from 'fast-check';
import {
  checkEnginesConsistency,
  isEnginesPrerequisiteConsistent,
  parseEnginesRange,
} from './enginesConsistency';

/** Oracle for the consistency predicate, derived directly from Requirements 3.2/3.3. */
function expectedConsistent(min: number, max: number, p: number): boolean {
  return min === p && p >= min && p < max;
}

describe('Feature: codebase-modernization-refresh, Property 2 — Node engines / workshop-prerequisite consistency', () => {
  it('checker passes iff min === p AND min <= p < max, over arbitrary (min, max, p) (Req 3.2, 3.3)', () => {
    fc.assert(
      fc.property(
        // Well-formed range: min inclusive, max strictly greater (exclusive upper bound).
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 80 }),
        (min, span, p) => {
          const max = min + span; // guarantees max > min (a valid ordered range)
          const enginesRange = `>=${min}.0.0 <${max}.0.0`;
          const packageJsonPath = 'package.json';

          const result = checkEnginesConsistency({ enginesRange, prerequisite: p, packageJsonPath });
          const oracle = expectedConsistent(min, max, p);

          expect(result.consistent).toBe(oracle);
          // The core predicate agrees with the full checker on the parsed bounds.
          expect(isEnginesPrerequisiteConsistent(min, max, p)).toBe(oracle);

          if (oracle) {
            // Consistent declarations report no offending file (Req 3.2 satisfied).
            expect(result.offendingFile).toBeUndefined();
          } else {
            // Inconsistent declarations identify the conflicting package.json (Req 3.3).
            expect(result.offendingFile).toBe(packageJsonPath);
            expect(typeof result.reason).toBe('string');
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it('passes exactly when the prerequisite equals the engines minimum of an in-bounds range (Req 3.2)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 30 }),
        (min, span) => {
          const max = min + span;
          const enginesRange = `>=${min}.0.0 <${max}.0.0`;
          // p == min is always consistent for a well-formed range.
          const consistent = checkEnginesConsistency({
            enginesRange,
            prerequisite: min,
            packageJsonPath: 'pkg/package.json',
          });
          expect(consistent.consistent).toBe(true);

          // Any p != min (still numeric) is inconsistent, and is reported (Req 3.3).
          const offByOne = checkEnginesConsistency({
            enginesRange,
            prerequisite: min + 1,
            packageJsonPath: 'pkg/package.json',
          });
          expect(offByOne.consistent).toBe(false);
          expect(offByOne.offendingFile).toBe('pkg/package.json');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('flags a prerequisite outside the declared range as inconsistent and reports the file (Req 3.3)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 20 }),
        (min, span, over) => {
          const max = min + span;
          const enginesRange = `>=${min}.0.0 <${max}.0.0`;
          // p strictly above the exclusive upper bound — out of range.
          const aboveMax = max + over;
          const result = checkEnginesConsistency({
            enginesRange,
            prerequisite: aboveMax,
            packageJsonPath: 'app-plane/package.json',
          });
          expect(result.consistent).toBe(false);
          expect(result.offendingFile).toBe('app-plane/package.json');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('the real engines string ">=22.0.0 <25.0.0" parses to [22, 25) and is consistent only with prerequisite 22', () => {
    const parsed = parseEnginesRange('>=22.0.0 <25.0.0');
    expect(parsed).toEqual({ min: 22, max: 25 });

    expect(
      checkEnginesConsistency({
        enginesRange: '>=22.0.0 <25.0.0',
        prerequisite: 22,
        packageJsonPath: 'package.json',
      }).consistent
    ).toBe(true);

    for (const p of [18, 20, 23, 24, 25]) {
      expect(
        checkEnginesConsistency({
          enginesRange: '>=22.0.0 <25.0.0',
          prerequisite: p,
          packageJsonPath: 'package.json',
        }).consistent
      ).toBe(false);
    }
  });
});
