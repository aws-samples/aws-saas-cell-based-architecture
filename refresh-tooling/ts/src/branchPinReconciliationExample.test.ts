/**
 * Dedicated unit test for the Branch-Pin / Version Reconciler design example
 * (Design Component 9, CC11) — task 15.4.
 *
 * Design example: a workshop branch pin of `v1.3.1` and a repository
 * `package.json` version of `1.2.1` must resolve to the target release tag
 * `1.3.1` (the higher of the two by semantic-version precedence, with the
 * optional leading `v` stripped from the canonical tag).
 *
 * The general parse/compare/halt coverage lives in branchPinReconciler.test.ts
 * and the property test is task 15.3; this file isolates the single documented
 * example (plus its commutative and idempotent variants) so the canonical
 * design scenario is independently verifiable.
 *
 * Requirements covered: 13.1 (read + resolve higher-by-semver).
 *
 * Feature: codebase-modernization-refresh
 */
import { resolveHigherTag, reconcileVersions } from './branchPinReconciler';

describe('branch-pin reconciliation design example: v1.3.1 vs 1.2.1 -> 1.3.1 (Req 13.1)', () => {
  it('resolves the documented example v1.3.1 vs 1.2.1 to the canonical tag 1.3.1', () => {
    expect(resolveHigherTag('v1.3.1', '1.2.1')).toEqual({ resolvedTag: '1.3.1' });
  });

  it('resolves the example commutatively (1.2.1 vs v1.3.1 also yields 1.3.1)', () => {
    expect(resolveHigherTag('1.2.1', 'v1.3.1')).toEqual({ resolvedTag: '1.3.1' });
  });

  it('is idempotent on the higher version of the example (v1.3.1 vs 1.3.1 -> 1.3.1)', () => {
    expect(resolveHigherTag('v1.3.1', '1.3.1')).toEqual({ resolvedTag: '1.3.1' });
  });

  it('reconcileVersions surfaces the example result with applied=false', () => {
    expect(reconcileVersions({ currentPin: 'v1.3.1', repoVersion: '1.2.1' })).toEqual({
      currentPin: 'v1.3.1',
      repoVersion: '1.2.1',
      resolvedTag: '1.3.1',
      applied: false,
    });
  });
});
