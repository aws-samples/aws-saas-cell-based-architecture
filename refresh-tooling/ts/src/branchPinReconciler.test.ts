/**
 * Unit tests for the Branch-Pin / Version Reconciler (Design Component 9, CC11).
 *
 * Requirements covered: 13.1 (read + resolve higher-by-semver), 13.5 (halt on
 * invalid/unorderable versions leaving the pin and both versions unchanged).
 *
 * The `v1.3.1` vs `1.2.1` -> `1.3.1` design example is exercised here; the
 * dedicated property test for semantic-version tag resolution is task 15.3.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  parseSemver,
  compareSemver,
  resolveHigherTag,
  formatTag,
  extractRepoBranchName,
  reconcileVersions,
} from './branchPinReconciler';

describe('parseSemver — tolerant of an optional leading v (Req 13.1)', () => {
  it('parses a plain semver', () => {
    expect(parseSemver('1.2.1')).toEqual({
      major: 1,
      minor: 2,
      patch: 1,
      prerelease: [],
      build: [],
    });
  });

  it('parses a v-prefixed semver', () => {
    expect(parseSemver('v1.3.1')).toEqual({
      major: 1,
      minor: 3,
      patch: 1,
      prerelease: [],
      build: [],
    });
  });

  it('parses prerelease and build metadata', () => {
    expect(parseSemver('2.0.0-alpha.1+build.5')).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: ['alpha', '1'],
      build: ['build', '5'],
    });
  });

  it.each(['main', '', 'v', '1.2', '1.2.x', '01.2.3', 'latest', '1.2.3.4'])(
    'returns null for non-semver %p',
    (v) => {
      expect(parseSemver(v)).toBeNull();
    }
  );
});

describe('compareSemver — precedence major > minor > patch > prerelease', () => {
  const cmp = (a: string, b: string) =>
    compareSemver(parseSemver(a)!, parseSemver(b)!);

  it('orders by major then minor then patch', () => {
    expect(cmp('2.0.0', '1.9.9')).toBe(1);
    expect(cmp('1.3.0', '1.2.9')).toBe(1);
    expect(cmp('1.2.2', '1.2.1')).toBe(1);
    expect(cmp('1.2.1', '1.2.1')).toBe(0);
  });

  it('treats a release as higher precedence than a prerelease', () => {
    expect(cmp('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(cmp('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(cmp('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
  });

  it('ignores build metadata in precedence', () => {
    expect(cmp('1.2.1+a', '1.2.1+b')).toBe(0);
  });
});

describe('resolveHigherTag — higher by semver precedence (Req 13.1)', () => {
  it('resolves v1.3.1 vs 1.2.1 to 1.3.1 (design example)', () => {
    expect(resolveHigherTag('v1.3.1', '1.2.1')).toEqual({ resolvedTag: '1.3.1' });
  });

  it('is commutative over the design example', () => {
    expect(resolveHigherTag('1.2.1', 'v1.3.1')).toEqual({ resolvedTag: '1.3.1' });
  });

  it('is idempotent for equal versions', () => {
    expect(resolveHigherTag('1.2.1', '1.2.1')).toEqual({ resolvedTag: '1.2.1' });
    expect(resolveHigherTag('v1.2.1', '1.2.1')).toEqual({ resolvedTag: '1.2.1' });
  });

  it('strips a leading v from the resolved tag', () => {
    expect(resolveHigherTag('v2.0.0', 'v1.0.0').resolvedTag).toBe('2.0.0');
    expect(formatTag(parseSemver('v2.0.0')!)).toBe('2.0.0');
  });

  it('halts on an invalid Branch_Pin, leaving no resolved tag (Req 13.5)', () => {
    const r = resolveHigherTag('main', '1.2.1');
    expect(r.resolvedTag).toBe('');
    expect(r.error).toMatch(/main/);
    expect(r.error).toMatch(/Req 13\.5/);
  });

  it('halts on an invalid repo version (Req 13.5)', () => {
    const r = resolveHigherTag('v1.3.1', 'not-a-version');
    expect(r.resolvedTag).toBe('');
    expect(r.error).toMatch(/not-a-version/);
  });

  it('reports both offenders when both are invalid (Req 13.5)', () => {
    const r = resolveHigherTag('main', 'dev');
    expect(r.resolvedTag).toBe('');
    expect(r.error).toMatch(/main/);
    expect(r.error).toMatch(/dev/);
  });
});

describe('branch-pin reconciliation canonical example (task 15.4, Req 13.1)', () => {
  // Design example: the workshop Branch_Pin (RepoBranchName = "v1.3.1") and the
  // Control_Plane_App root package.json version (1.2.1) reconcile to the higher
  // of the two by semver precedence, i.e. 1.3.1 (leading `v` stripped).
  const BRANCH_PIN = 'v1.3.1';
  const REPO_VERSION = '1.2.1';
  const EXPECTED_TAG = '1.3.1';

  it('resolveHigherTag("v1.3.1", "1.2.1") === "1.3.1"', () => {
    expect(resolveHigherTag(BRANCH_PIN, REPO_VERSION)).toEqual({
      resolvedTag: EXPECTED_TAG,
    });
  });

  it('is commutative: resolveHigherTag("1.2.1", "v1.3.1") === "1.3.1"', () => {
    expect(resolveHigherTag(REPO_VERSION, BRANCH_PIN)).toEqual({
      resolvedTag: EXPECTED_TAG,
    });
  });

  it('reconcileVersions reports resolvedTag "1.3.1" and never applies', () => {
    expect(reconcileVersions({ currentPin: BRANCH_PIN, repoVersion: REPO_VERSION })).toEqual({
      currentPin: BRANCH_PIN,
      repoVersion: REPO_VERSION,
      resolvedTag: EXPECTED_TAG,
      applied: false,
    });
  });
});

describe('extractRepoBranchName — reads the WorkshopStack.yaml parameter default', () => {
  const yaml = `Parameters:
  RepoUrl:
    Type: String
    Description: The URL of the repo.
  RepoBranchName:
    Type: String
    Description: The branch to be used for the workshop.
    Default: "v1.3.1"
  RepoName:
    Type: String
    Default: "aws-saas-cell-based-architecture"
`;

  it('extracts a quoted default', () => {
    expect(extractRepoBranchName(yaml)).toBe('v1.3.1');
  });

  it('extracts an unquoted default', () => {
    const body = yaml.replace('"v1.3.1"', 'main');
    expect(extractRepoBranchName(body)).toBe('main');
  });

  it('returns null when the parameter is absent', () => {
    expect(extractRepoBranchName('Parameters:\n  Other:\n    Type: String\n')).toBeNull();
  });
});

describe('reconcileVersions — read + resolve, never applies (Req 13.1, 13.5)', () => {
  it('resolves the higher tag from explicit values and leaves applied=false', () => {
    const result = reconcileVersions({ currentPin: 'v1.3.1', repoVersion: '1.2.1' });
    expect(result).toEqual({
      currentPin: 'v1.3.1',
      repoVersion: '1.2.1',
      resolvedTag: '1.3.1',
      applied: false,
    });
  });

  it('halts and preserves the reported pin/version on an invalid pin (Req 13.5)', () => {
    const result = reconcileVersions({ currentPin: 'main', repoVersion: '1.2.1' });
    expect(result.applied).toBe(false);
    expect(result.resolvedTag).toBe('');
    expect(result.currentPin).toBe('main');
    expect(result.repoVersion).toBe('1.2.1');
    expect(result.error).toBeDefined();
  });

  it('reads the live workshop pin and repo version and never applies', () => {
    const result = reconcileVersions();
    // applying is task 15.2; this component only reads + resolves.
    expect(result.applied).toBe(false);
    expect(typeof result.currentPin).toBe('string');
    expect(typeof result.repoVersion).toBe('string');
    // Either a resolved tag (both semver) or a halt error (Req 13.5) — never both.
    if (result.error) {
      expect(result.resolvedTag).toBe('');
    } else {
      expect(result.resolvedTag).not.toBe('');
    }
  });
});
