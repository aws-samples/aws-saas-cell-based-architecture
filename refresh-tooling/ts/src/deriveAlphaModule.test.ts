/**
 * Focused unit tests for alpha-suffix derivation (Task 2.4).
 *
 * Asserts that {@link deriveAlphaModule} appends the `-alpha.0` suffix convention
 * (`v` -> `v-alpha.0`) character-for-character for representative `aws-cdk-lib`
 * versions, so the Alpha_Module (`@aws-cdk/aws-lambda-python-alpha`) never drifts
 * from the stable line it mirrors.
 *
 * Requirements covered: 1.3.
 *
 * Feature: codebase-modernization-refresh
 */
import { deriveAlphaModule, planVersions } from './dependencyUpgradePlanner';

describe('alpha-suffix derivation (Req 1.3)', () => {
  it('derives the canonical target 2.258.0 -> 2.258.0-alpha.0', () => {
    expect(deriveAlphaModule('2.258.0')).toBe('2.258.0-alpha.0');
  });

  describe('representative aws-cdk-lib versions map to <version>-alpha.0', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['2.258.0', '2.258.0-alpha.0'],
      ['2.260.0', '2.260.0-alpha.0'],
      ['2.222.0', '2.222.0-alpha.0'],
      ['2.1031.1', '2.1031.1-alpha.0'],
      ['2.150.10', '2.150.10-alpha.0'],
      ['3.0.0', '3.0.0-alpha.0'],
      ['10.4.2', '10.4.2-alpha.0'],
    ];

    it.each(cases)('derives %s -> %s', (input, expected) => {
      expect(deriveAlphaModule(input)).toBe(expected);
    });
  });

  it('produces a result that is the input followed exactly by the suffix', () => {
    const suffix = '-alpha.0';
    for (const v of ['2.258.0', '2.260.0', '2.300.5']) {
      const derived = deriveAlphaModule(v);
      expect(derived.startsWith(v)).toBe(true);
      expect(derived.slice(v.length)).toBe(suffix);
      expect(derived).toBe(v + suffix);
    }
  });

  it('matches the Alpha_Module version produced by planVersions for the canonical lib', () => {
    const vs = planVersions();
    expect(deriveAlphaModule(vs.awsCdkLib)).toBe(vs.alphaModule);
  });
});
