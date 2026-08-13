/**
 * Unit tests for the Lockstep Comparator (Design Component 2).
 *
 * Requirements covered: 2.3, 2.4, 2.5, 2.6.
 *
 * Feature: codebase-modernization-refresh
 */
import * as path from 'path';
import { compare, compareAppPackageFiles, CDK_DEPENDENCIES } from './lockstepComparator';
import { ALPHA_MODULE_NAME } from './dependencyUpgradePlanner';
import type { PackageJson } from './models';

/** A lockstep-consistent control-plane package.json (CDK deps all resolved identically). */
const controlPlane: PackageJson = {
  name: 'saas-cell-based-architecture',
  version: '1.2.1',
  devDependencies: {
    '@types/jest': '^29.5.12',
    '@types/node': '^22.20.0',
    'aws-cdk': '2.1128.0',
    jest: '^29.7.0',
    'ts-jest': '^29.4.4',
    'ts-node': '^10.9.2',
    typescript: '~5.9.3',
  },
  dependencies: {
    '@aws-cdk/aws-lambda-python-alpha': '2.260.0-alpha.0',
    'aws-cdk-lib': '2.260.0',
    constructs: '^10.6.0',
    'cdk-nag': '2.38.2',
  },
};

/** A matching app-plane package.json with identical CDK_Dependencies. */
const appPlane: PackageJson = {
  name: 'cell-app-plane',
  version: '0.2.1',
  devDependencies: {
    '@types/jest': '^29.5.12',
    '@types/node': '^22.20.0',
    'aws-cdk': '2.1128.0',
    jest: '^29.7.0',
    'ts-jest': '^29.4.4',
    'ts-node': '^10.9.2',
    typescript: '~5.9.3',
  },
  dependencies: {
    '@aws-cdk/aws-lambda-python-alpha': '2.260.0-alpha.0',
    'aws-cdk-lib': '2.260.0',
    constructs: '^10.6.0',
    'cdk-nag': '2.38.2',
    'source-map-support': '^0.5.21',
  },
};

/** Deep clone helper so individual tests can mutate a copy without bleed-over. */
const clone = (p: PackageJson): PackageJson => JSON.parse(JSON.stringify(p));

describe('compare — matched case (Req 2.3)', () => {
  it('reports every CDK_Dependencies entry as matched and no failure', () => {
    const report = compare(controlPlane, appPlane);
    expect(report.matched.sort()).toEqual([...CDK_DEPENDENCIES].sort());
    expect(report.divergent).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.isFailure).toBe(false);
  });

  it('matches a CDK dependency regardless of which section it lives in', () => {
    // aws-cdk is in devDependencies; aws-cdk-lib is in dependencies — both matched.
    const report = compare(controlPlane, appPlane);
    expect(report.matched).toContain('aws-cdk');
    expect(report.matched).toContain('aws-cdk-lib');
  });
});

describe('compare — divergent case (Req 2.4)', () => {
  it('flags a divergent entry with both differing version strings and marks failure', () => {
    const ap = clone(appPlane);
    ap.dependencies!['aws-cdk-lib'] = '2.258.0';
    const report = compare(controlPlane, ap);

    expect(report.isFailure).toBe(true);
    expect(report.divergent).toEqual([
      { name: 'aws-cdk-lib', controlPlane: '2.260.0', appPlane: '2.258.0' },
    ]);
    expect(report.matched).not.toContain('aws-cdk-lib');
  });

  it('flags multiple divergent entries', () => {
    const ap = clone(appPlane);
    ap.dependencies!['aws-cdk-lib'] = '2.258.0';
    ap.dependencies!['cdk-nag'] = '2.36.18';
    const report = compare(controlPlane, ap);

    expect(report.isFailure).toBe(true);
    expect(report.divergent.map((d) => d.name).sort()).toEqual(['aws-cdk-lib', 'cdk-nag']);
  });

  it('treats the Alpha_Module drifting from aws-cdk-lib as a divergence', () => {
    const ap = clone(appPlane);
    ap.dependencies![ALPHA_MODULE_NAME] = '2.258.0-alpha.0';
    const report = compare(controlPlane, ap);

    expect(report.isFailure).toBe(true);
    expect(report.divergent).toEqual([
      { name: ALPHA_MODULE_NAME, controlPlane: '2.260.0-alpha.0', appPlane: '2.258.0-alpha.0' },
    ]);
  });
});

describe('compare — missing case (Req 2.5)', () => {
  it('flags an entry absent from the app-plane set', () => {
    const ap = clone(appPlane);
    delete ap.dependencies!['cdk-nag'];
    const report = compare(controlPlane, ap);

    expect(report.isFailure).toBe(true);
    expect(report.missing).toEqual([{ name: 'cdk-nag', absentIn: 'app-plane' }]);
  });

  it('flags an entry absent from the control-plane set', () => {
    const cp = clone(controlPlane);
    delete cp.devDependencies!['aws-cdk'];
    const report = compare(cp, appPlane);

    expect(report.isFailure).toBe(true);
    expect(report.missing).toEqual([{ name: 'aws-cdk', absentIn: 'control-plane' }]);
  });

  it('does not flag an entry absent from BOTH apps', () => {
    const cp = clone(controlPlane);
    const ap = clone(appPlane);
    delete cp.dependencies!['cdk-nag'];
    delete ap.dependencies!['cdk-nag'];
    const report = compare(cp, ap);

    expect(report.missing).toEqual([]);
    expect(report.divergent).toEqual([]);
    expect(report.isFailure).toBe(false);
  });
});

describe('compareAppPackageFiles — real repository apps (Req 2.3, CC1 verification)', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const controlPlanePath = path.join(repoRoot, 'package.json');
  const appPlanePath = path.join(
    repoRoot,
    'lib/application-plane/cell-app-plane/cdk/package.json'
  );

  it('confirms both real apps are in lockstep with no failure', () => {
    const report = compareAppPackageFiles(controlPlanePath, appPlanePath);
    expect(report.divergent).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.isFailure).toBe(false);
    expect(report.matched.sort()).toEqual([...CDK_DEPENDENCIES].sort());
  });
});
