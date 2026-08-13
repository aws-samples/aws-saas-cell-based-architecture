/**
 * Property-based tests for the Runtime Alignment Checker.
 *
 * Feature: codebase-modernization-refresh, Property 3
 *
 * Property 3: Runtime version alignment across all runtime-bearing surfaces
 * Validates: Requirements 4.1, 4.3, 17.3
 *
 * Over arbitrary runtime-bearing inputs — the Lambda Python runtime, the Flask
 * container base image, and the bootstrap inline-Lambda runtimes — the checker MUST
 * report `aligned === true` IFF every surface references the SAME Python
 * major.minor version, and MUST report `aligned === false` with a populated
 * `mismatches[]` otherwise. Surfaces are encoded in their natural forms
 * (`PYTHON_3_13`, `python:3.13-slim`, `python3.13`); the checker normalizes each to
 * `<major>.<minor>` before comparing (Req 4.1/4.3 Lambda↔Flask, Req 17.3 bootstrap
 * runtimes anchored to the repository baseline).
 */
import fc from 'fast-check';
import {
  checkAlignment,
  extractMajorMinor,
  AlignmentInput,
} from './runtimeAlignmentChecker';

/** A Python (major, minor) pair within realistic bounds. */
const versionArb = fc.record({
  major: fc.integer({ min: 2, max: 4 }),
  minor: fc.integer({ min: 0, max: 20 }),
});

type Version = { major: number; minor: number };

const majorMinor = (v: Version): string => `${v.major}.${v.minor}`;

/** Render a version in the Lambda-runtime enum form, e.g. "PYTHON_3_13". */
const asLambdaRuntime = (v: Version): string => `PYTHON_${v.major}_${v.minor}`;

/** Render a version as a Flask base image, e.g. "public.ecr.aws/docker/library/python:3.13-slim". */
const asFlaskImage = (v: Version): string =>
  `public.ecr.aws/docker/library/python:${v.major}.${v.minor}-slim`;

/** Render a version as a bootstrap inline-Lambda runtime, e.g. "python3.13". */
const asBootstrapRuntime = (v: Version): string => `python${v.major}.${v.minor}`;

describe('Feature: codebase-modernization-refresh, Property 3 — Runtime version alignment across all runtime-bearing surfaces', () => {
  it('extractMajorMinor normalizes every surface encoding of the same version to one major.minor (Req 4.1, 4.3, 17.3)', () => {
    fc.assert(
      fc.property(versionArb, (v) => {
        const expected = majorMinor(v);
        expect(extractMajorMinor(asLambdaRuntime(v))).toBe(expected);
        expect(extractMajorMinor(asFlaskImage(v))).toBe(expected);
        expect(extractMajorMinor(asBootstrapRuntime(v))).toBe(expected);
        expect(extractMajorMinor(expected)).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });

  it('reports aligned === true with no mismatches when every surface references the same Python major.minor (Req 4.1, 4.3, 17.3)', () => {
    fc.assert(
      fc.property(
        versionArb,
        fc.integer({ min: 1, max: 5 }),
        (v, bootstrapCount) => {
          const input: AlignmentInput = {
            lambdaRuntime: asLambdaRuntime(v),
            flaskBaseImage: asFlaskImage(v),
            bootstrapRuntimes: Array.from({ length: bootstrapCount }, () =>
              asBootstrapRuntime(v)
            ),
          };
          const report = checkAlignment(input);

          expect(report.aligned).toBe(true);
          expect(report.mismatches).toEqual([]);
          expect(report.lambdaPython).toBe(majorMinor(v));
          expect(report.flaskBaseImage).toBe(majorMinor(v));
          expect(report.bootstrapRuntimes).toEqual(input.bootstrapRuntimes);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('reports aligned === false with mismatches when the Flask base image diverges from the Lambda runtime (Req 4.1, 4.3)', () => {
    fc.assert(
      fc.property(versionArb, versionArb, (lambda, flask) => {
        fc.pre(majorMinor(lambda) !== majorMinor(flask));
        const input: AlignmentInput = {
          lambdaRuntime: asLambdaRuntime(lambda),
          flaskBaseImage: asFlaskImage(flask),
          bootstrapRuntimes: [asBootstrapRuntime(lambda)],
        };
        const report = checkAlignment(input);

        expect(report.aligned).toBe(false);
        expect(report.mismatches.length).toBeGreaterThan(0);
        // The mismatch identifies the offending Flask surface.
        expect(report.mismatches.some((m) => m.includes('Flask base image'))).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('reports aligned === false when any bootstrap inline-Lambda runtime diverges from the baseline (Req 17.3)', () => {
    fc.assert(
      fc.property(
        versionArb,
        versionArb,
        fc.array(versionArb, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 3 }),
        (baseline, divergent, others, insertAt) => {
          fc.pre(majorMinor(baseline) !== majorMinor(divergent));
          // A list of baseline-matching runtimes with one divergent runtime inserted.
          const runtimes = others.map(() => asBootstrapRuntime(baseline));
          const idx = insertAt % (runtimes.length + 1);
          runtimes.splice(idx, 0, asBootstrapRuntime(divergent));

          const input: AlignmentInput = {
            lambdaRuntime: asLambdaRuntime(baseline),
            flaskBaseImage: asFlaskImage(baseline),
            bootstrapRuntimes: runtimes,
          };
          const report = checkAlignment(input);

          expect(report.aligned).toBe(false);
          expect(report.mismatches.some((m) => m.includes('Bootstrap runtime'))).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('aligned IFF all surfaces share one major.minor — full oracle over mixed encodings (Req 4.1, 4.3, 17.3)', () => {
    fc.assert(
      fc.property(
        versionArb,
        versionArb,
        fc.array(versionArb, { minLength: 1, maxLength: 5 }),
        (lambda, flask, bootstraps) => {
          const input: AlignmentInput = {
            lambdaRuntime: asLambdaRuntime(lambda),
            flaskBaseImage: asFlaskImage(flask),
            bootstrapRuntimes: bootstraps.map(asBootstrapRuntime),
          };
          const report = checkAlignment(input);

          const base = majorMinor(lambda);
          const allEqual =
            majorMinor(flask) === base &&
            bootstraps.every((b) => majorMinor(b) === base);

          expect(report.aligned).toBe(allEqual);
          if (allEqual) {
            expect(report.mismatches).toEqual([]);
          } else {
            expect(report.mismatches.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it('the real refreshed baseline (Lambda PYTHON_3_13 / Flask python:3.13-slim / bootstrap python3.13) is aligned', () => {
    const report = checkAlignment({
      lambdaRuntime: 'PYTHON_3_13',
      flaskBaseImage: 'public.ecr.aws/docker/library/python:3.13-slim',
      bootstrapRuntimes: ['python3.13', 'python3.13'],
    });
    expect(report.aligned).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.lambdaPython).toBe('3.13');
    expect(report.flaskBaseImage).toBe('3.13');
  });
});
