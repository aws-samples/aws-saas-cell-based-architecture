/**
 * Property-based tests for the Artifact Untracker classifier (Design Component 8, CC8).
 *
 * Feature: codebase-modernization-refresh, Property 8
 *
 * Property 8: Build-artifact classification preserves intentional sources
 * Validates: Requirements 8.1, 8.4, 8.6
 *
 * Over arbitrary file paths and sibling-existence configurations, `classify`
 * MUST return:
 *   - "generated" IFF the file is a `.js`/`.d.ts` candidate that has a sibling
 *     `.ts` of the same base name AND is not in a preserved path (Req 8.1); and
 *   - "preserved" for, in every case,
 *       (a) `cell-router.js` under the cell-router functions path — the
 *           `.gitignore` negation rule (Req 8.4),
 *       (b) any file under `Solution/*` — committed Answer_Keys — even when it
 *           has a sibling `.ts` (Req 8.6), and
 *       (c) any `.js`/`.d.ts` with no sibling `.ts` (Req 8.4).
 *
 * The oracle below is derived independently from the requirement text (it does
 * not call the module's `classify`), so the property is a genuine cross-check of
 * the discriminator rather than a tautology.
 */
import fc from 'fast-check';
import {
  classify,
  isArtifactCandidate,
  siblingTsPathFor,
  CELL_ROUTER_FUNCTIONS_DIR,
  ANSWER_KEY_ROOT,
} from './artifactUntracker';

/* ----------------------------- Independent oracle ----------------------------- */

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Req 8.6: a path is an Answer_Key iff it has a `Solution` directory segment. */
function oracleIsAnswerKey(p: string): boolean {
  return normalizePath(p)
    .split('/')
    .filter((s) => s.length > 0)
    .includes(ANSWER_KEY_ROOT);
}

/** Req 8.4: the cell-router negation rule covers `*.js` under the functions dir. */
function oracleIsNegation(p: string): boolean {
  const f = normalizePath(p);
  return f.includes(`${CELL_ROUTER_FUNCTIONS_DIR}/`) && f.endsWith('.js');
}

function oracleIsCandidate(p: string): boolean {
  const f = normalizePath(p);
  return f.endsWith('.js') || f.endsWith('.d.ts');
}

type OracleResult = {
  classification: 'generated' | 'preserved';
  preserveReason?: 'negation-rule' | 'answer-key' | 'no-sibling-ts';
};

/**
 * Reference classification, derived straight from Requirements 8.1/8.4/8.6 with
 * the design's preservation precedence (answer-key, then negation rule, then
 * no-sibling-ts; otherwise generated).
 */
function oracleClassify(path: string, hasSiblingTs: boolean): OracleResult {
  if (oracleIsAnswerKey(path)) {
    return { classification: 'preserved', preserveReason: 'answer-key' };
  }
  if (oracleIsNegation(path)) {
    return { classification: 'preserved', preserveReason: 'negation-rule' };
  }
  if (!hasSiblingTs) {
    return { classification: 'preserved', preserveReason: 'no-sibling-ts' };
  }
  return { classification: 'generated' };
}

/* ------------------------------- Generators ----------------------------------- */

// A pool of directory segments mixing benign names with segments that appear in
// preserved paths, so generated paths land both inside and outside preserved
// regions adversarially.
const segmentArb = fc.constantFrom(
  'lib',
  'bin',
  'application-plane',
  'common-components',
  'cell-router',
  'src',
  'functions',
  'Solution',
  'lab01',
  'lab03',
  'node_modules',
  'foo',
  'bar',
  'baz',
  'nested'
);

const dirArb = fc.array(segmentArb, { minLength: 0, maxLength: 6 });

const baseNameArb = fc.constantFrom(
  'cell-router',
  'CellStack',
  'observability-stack',
  'cell-management-system-stack',
  'index',
  'helper',
  'main',
  'a',
  'b'
);

// Includes candidate (.js/.d.ts) and non-candidate (.ts/.json/.txt) extensions
// so the throw-on-non-candidate behavior is exercised too.
const extArb = fc.constantFrom('.js', '.d.ts', '.ts', '.json', '.txt');

// Optionally force a preserved prefix so the negation/answer-key branches are hit
// frequently, including when nested deeper than the immediate directory.
const prefixModeArb = fc.constantFrom('none', 'cell-router-functions', 'solution');

const pathConfigArb = fc
  .record({
    dir: dirArb,
    base: baseNameArb,
    ext: extArb,
    prefixMode: prefixModeArb,
    useBackslashes: fc.boolean(),
    hasSiblingTs: fc.boolean(),
  })
  .map(({ dir, base, ext, prefixMode, useBackslashes, hasSiblingTs }) => {
    let segs = [...dir];
    if (prefixMode === 'cell-router-functions') {
      segs = [...CELL_ROUTER_FUNCTIONS_DIR.split('/'), ...segs];
    } else if (prefixMode === 'solution') {
      segs = [ANSWER_KEY_ROOT, ...segs];
    }
    const joined = [...segs, `${base}${ext}`].join('/');
    const path = useBackslashes ? joined.replace(/\//g, '\\') : joined;
    return { path, hasSiblingTs };
  });

/* --------------------------------- Properties --------------------------------- */

describe('Feature: codebase-modernization-refresh, Property 8 — Build-artifact classification preserves intentional sources', () => {
  it('classifies candidates by the requirement biconditional and rejects non-candidates (Req 8.1, 8.4, 8.6)', () => {
    fc.assert(
      fc.property(pathConfigArb, ({ path, hasSiblingTs }) => {
        if (!oracleIsCandidate(path)) {
          // A non-.js/.d.ts file is out of scope and MUST be rejected.
          expect(isArtifactCandidate(path)).toBe(false);
          expect(() => classify(path, hasSiblingTs)).toThrow(/candidate/);
          return;
        }

        const actual = classify(path, hasSiblingTs);
        const expected = oracleClassify(path, hasSiblingTs);

        // Req 8.1: "generated" exactly when there is a sibling .ts and the file
        // is in no preserved path.
        expect(actual.classification).toBe(expected.classification);
        expect(actual.preserveReason).toBe(expected.preserveReason);

        // The sibling flag is recorded faithfully on the classification.
        expect(actual.hasSiblingTs).toBe(hasSiblingTs);

        // Generated <=> candidate && sibling && not-preserved.
        const notPreserved =
          !oracleIsAnswerKey(path) && !oracleIsNegation(path);
        expect(actual.classification === 'generated').toBe(
          hasSiblingTs && notPreserved
        );
      }),
      { numRuns: 300 }
    );
  });

  it('ALWAYS preserves cell-router.js under the functions path via the negation rule, regardless of sibling (Req 8.4)', () => {
    fc.assert(
      fc.property(fc.boolean(), (hasSiblingTs) => {
        const cellRouter = `${CELL_ROUTER_FUNCTIONS_DIR}/cell-router.js`;
        const result = classify(cellRouter, hasSiblingTs);
        expect(result.classification).toBe('preserved');
        expect(result.preserveReason).toBe('negation-rule');
      }),
      { numRuns: 100 }
    );
  });

  it('ALWAYS preserves any file under Solution/* as an answer key, even with a sibling .ts (Req 8.6)', () => {
    const solutionFileArb = fc
      .record({
        dir: dirArb,
        base: baseNameArb,
        ext: fc.constantFrom('.js', '.d.ts'),
        hasSiblingTs: fc.boolean(),
      })
      .map(({ dir, base, ext, hasSiblingTs }) => ({
        path: [ANSWER_KEY_ROOT, ...dir, `${base}${ext}`].join('/'),
        hasSiblingTs,
      }));

    fc.assert(
      fc.property(solutionFileArb, ({ path, hasSiblingTs }) => {
        const result = classify(path, hasSiblingTs);
        expect(result.classification).toBe('preserved');
        expect(result.preserveReason).toBe('answer-key');
      }),
      { numRuns: 200 }
    );
  });

  it('ALWAYS preserves any .js/.d.ts that has no sibling .ts (Req 8.4)', () => {
    // Restrict to paths outside Solution so the governing reason is exactly the
    // missing sibling (Solution would preserve via answer-key regardless).
    const noSolutionDirArb = fc.array(
      fc.constantFrom('lib', 'bin', 'src', 'foo', 'bar', 'nested', 'cell-router'),
      { minLength: 0, maxLength: 5 }
    );
    const candidateArb = fc
      .record({
        dir: noSolutionDirArb,
        base: baseNameArb,
        ext: fc.constantFrom('.js', '.d.ts'),
      })
      .map(({ dir, base, ext }) => [...dir, `${base}${ext}`].join('/'));

    fc.assert(
      fc.property(candidateArb, (path) => {
        const result = classify(path, false);
        expect(result.classification).toBe('preserved');
      }),
      { numRuns: 200 }
    );
  });

  it('a candidate outside every preserved path with a sibling .ts is generated, and its sibling path resolves to .ts (Req 8.1)', () => {
    const genDirArb = fc.array(
      fc.constantFrom('lib', 'bin', 'src', 'foo', 'bar', 'nested', 'app'),
      { minLength: 1, maxLength: 5 }
    );
    const genArb = fc
      .record({
        dir: genDirArb,
        base: baseNameArb,
        ext: fc.constantFrom('.js', '.d.ts'),
      })
      .map(({ dir, base, ext }) => [...dir, `${base}${ext}`].join('/'));

    fc.assert(
      fc.property(genArb, (path) => {
        // These paths contain neither a `Solution` segment nor the cell-router
        // functions dir, so with a sibling .ts they must be generated.
        fc.pre(!oracleIsAnswerKey(path) && !oracleIsNegation(path));
        const result = classify(path, true);
        expect(result.classification).toBe('generated');
        expect(result.preserveReason).toBeUndefined();
        expect(siblingTsPathFor(path)).toMatch(/\.ts$/);
      }),
      { numRuns: 200 }
    );
  });
});
