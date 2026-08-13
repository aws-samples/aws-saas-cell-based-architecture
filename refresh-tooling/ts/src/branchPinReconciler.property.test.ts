/**
 * Property-based tests for the semantic-version tag resolution performed by the
 * Branch-Pin / Version Reconciler (Design Component 9, CC11) — task 15.3.
 *
 * Feature: codebase-modernization-refresh, Property 10
 *
 * Property 10: Semantic-version tag resolution
 * Validates: Requirements 13.1, 13.5
 *
 * For arbitrary version strings, `resolveHigherTag` MUST:
 *   - When BOTH inputs are valid semantic versions (tolerating an optional
 *     leading `v`), return the HIGHER of the two by semantic-version precedence
 *     (major, then minor, then patch, then prerelease) as a canonical tag, and
 *     do so commutatively (`resolveHigherTag(a,b) == resolveHigherTag(b,a)`) and
 *     idempotently (`resolveHigherTag(a,a) == canonical(a)`) — Req 13.1.
 *   - When EITHER input is not a valid / orderable semantic version, HALT with a
 *     populated `error` and an empty `resolvedTag`, leaving nothing resolved so
 *     the pin and both versions stay unchanged — Req 13.5.
 *
 * The expected ordering is established by CONSTRUCTION (a strictly-greater
 * version is derived from a base version by a precedence-dominating bump), so
 * the property is an independent cross-check of the resolver rather than a
 * reimplementation of its comparator.
 */
import fc from 'fast-check';
import { resolveHigherTag, parseSemver } from './branchPinReconciler';

/* --------------------------------- Model -------------------------------------- */

interface V {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** Canonical (no leading `v`) tag string for a model version — mirrors formatTag. */
function canonical(v: V): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length > 0 ? `${core}-${v.prerelease.join('.')}` : core;
}

/** Render a model version to a string, optionally with the tolerated `v` prefix. */
function toStr(v: V, withV: boolean): string {
  return (withV ? 'v' : '') + canonical(v);
}

/* ------------------------------- Generators ----------------------------------- */

const numComponentArb = fc.integer({ min: 0, max: 50 });

/** Prerelease identifiers that are valid per the parser (numeric or alphanumeric). */
const prereleaseIdArb = fc.constantFrom(
  'alpha',
  'beta',
  'rc',
  'snapshot',
  'x',
  '0',
  '1',
  '2',
  '10'
);

const prereleaseArb = fc.array(prereleaseIdArb, { minLength: 0, maxLength: 3 });

const versionArb: fc.Arbitrary<V> = fc.record({
  major: numComponentArb,
  minor: numComponentArb,
  patch: numComponentArb,
  prerelease: prereleaseArb,
});

const withVArb = fc.boolean();

/**
 * A pair of valid versions with a KNOWN strict ordering (`lower < higher`),
 * derived by applying a precedence-dominating bump so the ordering is certain
 * without reusing the resolver's comparator.
 */
const orderedPairArb = fc
  .record({
    base: versionArb,
    kind: fc.constantFrom('major', 'minor', 'patch', 'prerelease'),
    delta: fc.integer({ min: 1, max: 5 }),
    higherTail: versionArb,
    lowerWithV: withVArb,
    higherWithV: withVArb,
  })
  .map(({ base, kind, delta, higherTail, lowerWithV, higherWithV }) => {
    let lower: V;
    let higher: V;
    switch (kind) {
      case 'major':
        // A greater major dominates regardless of the remaining fields.
        lower = base;
        higher = { ...higherTail, major: base.major + delta };
        break;
      case 'minor':
        // Same major, greater minor dominates patch/prerelease.
        lower = base;
        higher = {
          major: base.major,
          minor: base.minor + delta,
          patch: higherTail.patch,
          prerelease: higherTail.prerelease,
        };
        break;
      case 'patch':
        // Same major.minor, greater patch dominates prerelease.
        lower = base;
        higher = {
          major: base.major,
          minor: base.minor,
          patch: base.patch + delta,
          prerelease: higherTail.prerelease,
        };
        break;
      case 'prerelease':
      default:
        // Same core: a release outranks an otherwise-identical prerelease.
        lower = {
          major: base.major,
          minor: base.minor,
          patch: base.patch,
          prerelease: base.prerelease.length > 0 ? base.prerelease : ['alpha'],
        };
        higher = {
          major: base.major,
          minor: base.minor,
          patch: base.patch,
          prerelease: [],
        };
        break;
    }
    return {
      lowerStr: toStr(lower, lowerWithV),
      higherStr: toStr(higher, higherWithV),
      canonicalHigher: canonical(higher),
    };
  });

/** Strings that are NOT valid semantic versions (validity defined by the parser). */
const invalidVersionArb = fc
  .oneof(
    fc.constantFrom(
      'main',
      'latest',
      'master',
      'HEAD',
      '1',
      '1.2',
      '1.2.3.4',
      'v',
      'vv1.2.3',
      'abc',
      '01.2.3',
      '1.02.3',
      '1.2.x',
      '1.2.-3',
      '',
      ' ',
      'release-1.2.3',
      '1.2.3 ',
      '-1.2.3'
    ),
    fc.string({ minLength: 0, maxLength: 12 })
  )
  .filter((s) => parseSemver(s) === null);

const anyVersionStringArb = fc.oneof(
  versionArb.chain((v) => withVArb.map((wv) => toStr(v, wv))),
  invalidVersionArb
);

/* --------------------------------- Properties --------------------------------- */

describe('Feature: codebase-modernization-refresh, Property 10 — Semantic-version tag resolution', () => {
  it('returns the higher version by semver precedence, commutatively, for two valid versions (Req 13.1)', () => {
    fc.assert(
      fc.property(orderedPairArb, ({ lowerStr, higherStr, canonicalHigher }) => {
        const forward = resolveHigherTag(lowerStr, higherStr);
        const reverse = resolveHigherTag(higherStr, lowerStr);

        // The higher version wins regardless of argument order (commutativity).
        expect(forward.error).toBeUndefined();
        expect(reverse.error).toBeUndefined();
        expect(forward.resolvedTag).toBe(canonicalHigher);
        expect(reverse.resolvedTag).toBe(canonicalHigher);
        expect(forward.resolvedTag).toBe(reverse.resolvedTag);
      }),
      { numRuns: 300 }
    );
  });

  it('is idempotent: resolving a valid version against itself yields its canonical tag (Req 13.1)', () => {
    fc.assert(
      fc.property(versionArb, withVArb, (v, withV) => {
        const s = toStr(v, withV);
        const result = resolveHigherTag(s, s);
        expect(result.error).toBeUndefined();
        expect(result.resolvedTag).toBe(canonical(v));
      }),
      { numRuns: 200 }
    );
  });

  it('resolves any two valid versions commutatively to one of the inputs (Req 13.1)', () => {
    const validStrArb = versionArb.chain((v) => withVArb.map((wv) => toStr(v, wv)));
    fc.assert(
      fc.property(validStrArb, validStrArb, (a, b) => {
        const ab = resolveHigherTag(a, b);
        const ba = resolveHigherTag(b, a);
        expect(ab.error).toBeUndefined();
        expect(ba.error).toBeUndefined();
        // Commutative: same resolved tag regardless of order.
        expect(ab.resolvedTag).toBe(ba.resolvedTag);
        // The winner is the canonical form of one of the two inputs.
        const canonA = canonical(parseSemver(a)!);
        const canonB = canonical(parseSemver(b)!);
        expect([canonA, canonB]).toContain(ab.resolvedTag);
      }),
      { numRuns: 300 }
    );
  });

  it('HALTS with an error and an empty resolvedTag when either input is not a valid semver (Req 13.5)', () => {
    fc.assert(
      fc.property(
        invalidVersionArb,
        anyVersionStringArb,
        fc.boolean(),
        (invalid, other, invalidFirst) => {
          const result = invalidFirst
            ? resolveHigherTag(invalid, other)
            : resolveHigherTag(other, invalid);

          // Req 13.5: resolution halts — empty tag and a populated error that
          // identifies the offending value so nothing is written/changed.
          expect(result.resolvedTag).toBe('');
          expect(typeof result.error).toBe('string');
          expect(result.error!.length).toBeGreaterThan(0);
          expect(result.error).toContain(invalid);
        }
      ),
      { numRuns: 300 }
    );
  });
});
