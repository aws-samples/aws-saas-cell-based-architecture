/**
 * Unit tests for the Dependency Upgrade Planner (Design Component 1).
 *
 * Requirements covered: 1.1, 1.3, 1.4, 1.5, 1.6.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  planVersions,
  plan_versions,
  apply,
  deriveAlphaModule,
  isExactPin,
  toExactPin,
  ALPHA_MODULE_NAME,
} from './dependencyUpgradePlanner';
import type { PackageJson } from './models';

const controlPlanePkg: PackageJson = {
  name: 'saas-cell-based-architecture',
  version: '1.2.1',
  devDependencies: {
    '@types/jest': '^29.5.12',
    '@types/node': '22.10.1',
    'aws-cdk': '2.1031.1',
    jest: '^29.7.0',
    'ts-jest': '^29.1.5',
    'ts-node': '^10.9.2',
    typescript: '~5.5.3',
  },
  dependencies: {
    '@aws-cdk/aws-lambda-python-alpha': '2.222.0-alpha.0',
    'aws-cdk-lib': '2.222.0',
    constructs: '^10.0.0',
    'cdk-nag': '2.36.18',
  },
};

const appPlanePkg: PackageJson = {
  name: 'cell-app-plane',
  version: '0.2.1',
  devDependencies: {
    '@types/jest': '^29.5.12',
    '@types/node': '22.10.1',
    'aws-cdk': '2.1031.1',
    jest: '^29.7.0',
    'ts-jest': '^29.1.5',
    'ts-node': '^10.9.2',
    typescript: '~5.5.3',
  },
  dependencies: {
    '@aws-cdk/aws-lambda-python-alpha': '2.222.0-alpha.0',
    'aws-cdk-lib': '2.222.0',
    constructs: '^10.0.0',
    'cdk-nag': '2.36.18',
    'source-map-support': '^0.5.21',
  },
};

describe('deriveAlphaModule (Req 1.3)', () => {
  it('appends the -alpha.0 suffix', () => {
    expect(deriveAlphaModule('2.258.0')).toBe('2.258.0-alpha.0');
    expect(deriveAlphaModule('2.222.0')).toBe('2.222.0-alpha.0');
  });
});

describe('isExactPin / toExactPin', () => {
  it('recognizes exact pins including prereleases', () => {
    expect(isExactPin('2.258.0')).toBe(true);
    expect(isExactPin('2.258.0-alpha.0')).toBe(true);
    expect(isExactPin('^10.4.2')).toBe(false);
    expect(isExactPin('~5.9.2')).toBe(false);
    expect(isExactPin('22.x')).toBe(false);
    expect(isExactPin('*')).toBe(false);
  });

  it('strips range prefixes to recover an exact pin', () => {
    expect(toExactPin('^22.10.1')).toBe('22.10.1');
    expect(toExactPin('~5.9.2')).toBe('5.9.2');
    expect(toExactPin('2.36.18')).toBe('2.36.18');
  });
});

describe('planVersions (Req 1.1, 1.3)', () => {
  it('produces aws-cdk-lib as an exact major.minor.patch (Req 1.1)', () => {
    const vs = planVersions();
    expect(isExactPin(vs.awsCdkLib)).toBe(true);
    expect(vs.awsCdkLib).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('derives the Alpha_Module to exactly match aws-cdk-lib (Req 1.3)', () => {
    const vs = planVersions();
    expect(vs.alphaModule).toBe(`${vs.awsCdkLib}-alpha.0`);
  });

  it('keeps exact-pin entries (cdk-nag, CLI) free of range prefixes (Req 1.5)', () => {
    const vs = planVersions();
    expect(isExactPin(vs.cdkNag)).toBe(true);
    expect(isExactPin(vs.awsCdkCli)).toBe(true);
  });

  it('exposes the snake_case alias from the design interface', () => {
    expect(plan_versions).toBe(planVersions);
  });
});

describe('apply (Req 1.1, 1.3, 1.4, 1.5, 1.6)', () => {
  const vs = planVersions();

  it('rewrites aws-cdk-lib to the planned exact version (Req 1.1)', () => {
    const res = apply('control-plane', vs, controlPlanePkg);
    expect(res.packageJson.dependencies!['aws-cdk-lib']).toBe(vs.awsCdkLib);
  });

  it('sets the Alpha_Module character-for-character to aws-cdk-lib + suffix (Req 1.3)', () => {
    const res = apply('control-plane', vs, controlPlanePkg);
    const alpha = res.packageJson.dependencies![ALPHA_MODULE_NAME];
    expect(alpha).toBe(`${res.packageJson.dependencies!['aws-cdk-lib']}-alpha.0`);
  });

  it('upgrades the peer set (Req 1.4)', () => {
    const res = apply('control-plane', vs, controlPlanePkg);
    expect(res.packageJson.dependencies!['constructs']).toBe(vs.constructs);
    expect(res.packageJson.dependencies!['cdk-nag']).toBe(vs.cdkNag);
    expect(res.packageJson.devDependencies!['typescript']).toBe(vs.typescript);
    expect(res.packageJson.devDependencies!['jest']).toBe(vs.jest);
    expect(res.packageJson.devDependencies!['ts-jest']).toBe(vs.tsJest);
    expect(res.packageJson.devDependencies!['ts-node']).toBe(vs.tsNode);
  });

  it('preserves exact-pin style for cdk-nag and the Alpha_Module (Req 1.5)', () => {
    const res = apply('control-plane', vs, controlPlanePkg);
    expect(isExactPin(res.packageJson.dependencies!['cdk-nag'])).toBe(true);
    expect(isExactPin(res.packageJson.dependencies![ALPHA_MODULE_NAME])).toBe(true);
  });

  it('preserves exact-pin style for previously exact-pinned @types/node and records a substitution (Req 1.5, 1.6)', () => {
    const res = apply('control-plane', vs, controlPlanePkg);
    const typesNode = res.packageJson.devDependencies!['@types/node'];
    expect(isExactPin(typesNode)).toBe(true);
    const sub = res.substitutions.find((s) => s.dependency === '@types/node');
    expect(sub).toBeDefined();
    expect(sub!.requestedVersion).toBe(vs.typesNode);
    expect(sub!.selectedVersion).toBe(typesNode);
    expect(sub!.reason).toMatch(/exact-pin/i);
  });

  it('leaves unmanaged dependencies untouched', () => {
    const res = apply('app-plane', vs, appPlanePkg);
    expect(res.packageJson.dependencies!['source-map-support']).toBe('^0.5.21');
    expect(res.packageJson.devDependencies!['@types/jest']).toBe('^29.5.12');
  });

  it('does not mutate the source package.json', () => {
    const before = JSON.stringify(controlPlanePkg);
    apply('control-plane', vs, controlPlanePkg);
    expect(JSON.stringify(controlPlanePkg)).toBe(before);
  });

  it('records a change entry only for dependencies whose version string actually changed', () => {
    const res = apply('control-plane', vs, controlPlanePkg);
    const names = res.changes.map((c) => c.dependency).sort();
    // @types/node is NOT listed: its exact-pinned target (22.10.1) equals the
    // original, so no version change occurs even though a style substitution is logged.
    expect(names).toEqual(
      [
        '@aws-cdk/aws-lambda-python-alpha',
        'aws-cdk-lib',
        'constructs',
        'typescript',
      ].sort()
    );
  });

  it('produces an identical resolved CDK set across both apps (lockstep, Req 1.3/2.1)', () => {
    const cp = apply('control-plane', vs, controlPlanePkg).packageJson;
    const ap = apply('app-plane', vs, appPlanePkg).packageJson;
    for (const name of ['aws-cdk-lib', ALPHA_MODULE_NAME, 'constructs', 'cdk-nag']) {
      expect(ap.dependencies![name]).toBe(cp.dependencies![name]);
    }
    expect(ap.devDependencies!['aws-cdk']).toBe(cp.devDependencies!['aws-cdk']);
  });
});
