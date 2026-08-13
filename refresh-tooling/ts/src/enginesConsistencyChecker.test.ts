/**
 * Unit tests for the Engines / Workshop-Prerequisite Consistency Checker (CC2).
 *
 * Requirements covered: 3.2, 3.3.
 *
 * Feature: codebase-modernization-refresh
 */
import * as path from 'path';
import {
  checkEntry,
  checkEnginesConsistency,
  checkEnginesConsistencyForFiles,
  WORKSHOP_NODE_PREREQUISITE,
  type EnginesEntry,
} from './enginesConsistencyChecker';
import type { PackageJson } from './models';

/** Build a package.json with the given engines.node range. */
const pkgWithEngines = (node?: string): PackageJson => ({
  name: 'sample',
  ...(node !== undefined ? { engines: { node } } : {}),
});

const entry = (node: string | undefined, label = 'package.json'): EnginesEntry => ({
  packageJson: label,
  pkg: pkgWithEngines(node),
});

describe('checkEntry — matched case (Req 3.2, 3.3)', () => {
  it('passes when min == p and p is within [min, max)', () => {
    const r = checkEntry(entry('>=22.0.0 <25.0.0'), '22');
    expect(r.minVersion).toBe('22.0.0');
    expect(r.maxVersion).toBe('25.0.0');
    expect(r.minEqualsPrerequisite).toBe(true);
    expect(r.prerequisiteWithinRange).toBe(true);
    expect(r.consistent).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a prerequisite expressed as a full version (22.0.0)', () => {
    const r = checkEntry(entry('>=22.0.0 <25.0.0'), '22.0.0');
    expect(r.consistent).toBe(true);
  });

  it('defaults the prerequisite to the workshop Node version (22)', () => {
    const r = checkEntry(entry('>=22.0.0 <25.0.0'), WORKSHOP_NODE_PREREQUISITE);
    expect(r.consistent).toBe(true);
  });
});

describe('checkEntry — min != p (Req 3.2)', () => {
  it('fails and reports the offending file when the minimum differs from p', () => {
    const r = checkEntry(entry('>=20.0.0 <25.0.0', 'control/package.json'), '22');
    expect(r.minEqualsPrerequisite).toBe(false);
    expect(r.consistent).toBe(false);
    expect(r.errors.join('\n')).toContain('control/package.json');
    expect(r.errors.join('\n')).toContain('Req 3.2');
  });

  it('fails when the minimum is higher than p even though both share a range', () => {
    const r = checkEntry(entry('>=23.0.0 <25.0.0'), '22');
    // min (23) != p (22), and p (22) is below the lower bound -> outside range too
    expect(r.minEqualsPrerequisite).toBe(false);
    expect(r.prerequisiteWithinRange).toBe(false);
    expect(r.consistent).toBe(false);
  });
});

describe('checkEntry — p out of range (Req 3.3)', () => {
  it('fails when p is at/above the exclusive upper bound', () => {
    // min == p (25) but p is NOT within [25, 25) since 25 is the exclusive max.
    const r = checkEntry(entry('>=25.0.0 <25.0.0'), '25');
    expect(r.minEqualsPrerequisite).toBe(true);
    expect(r.prerequisiteWithinRange).toBe(false);
    expect(r.consistent).toBe(false);
    expect(r.errors.join('\n')).toContain('Req 3.3');
  });

  it('reports outside-range when p exceeds the upper bound', () => {
    const r = checkEntry(entry('>=22.0.0 <25.0.0'), '26');
    expect(r.prerequisiteWithinRange).toBe(false);
    expect(r.consistent).toBe(false);
  });
});

describe('checkEntry — malformed / missing engines', () => {
  it('fails and reports when engines.node is absent', () => {
    const r = checkEntry(entry(undefined, 'no-engines/package.json'), '22');
    expect(r.consistent).toBe(false);
    expect(r.nodeEngines).toBeUndefined();
    expect(r.errors.join('\n')).toContain('no engines.node');
  });

  it('fails and reports when engines.node is not parseable', () => {
    const r = checkEntry(entry('not-a-range', 'bad/package.json'), '22');
    expect(r.consistent).toBe(false);
    expect(r.errors.join('\n')).toContain('not parseable');
  });
});

describe('checkEnginesConsistency — aggregate over both apps (Req 3.3)', () => {
  it('passes with no offending files when both apps are consistent', () => {
    const report = checkEnginesConsistency(
      [entry('>=22.0.0 <25.0.0', 'a/package.json'), entry('>=22.0.0 <25.0.0', 'b/package.json')],
      '22'
    );
    expect(report.isFailure).toBe(false);
    expect(report.offending).toEqual([]);
  });

  it('reports exactly the offending package.json files', () => {
    const report = checkEnginesConsistency(
      [
        entry('>=22.0.0 <25.0.0', 'good/package.json'),
        entry('>=20.0.0 <25.0.0', 'bad/package.json'),
      ],
      '22'
    );
    expect(report.isFailure).toBe(true);
    expect(report.offending).toEqual(['bad/package.json']);
  });
});

describe('checkEnginesConsistencyForFiles — real repository apps (Req 3.2, 3.3)', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const controlPlanePath = path.join(repoRoot, 'package.json');
  const appPlanePath = path.join(
    repoRoot,
    'lib/application-plane/cell-app-plane/cdk/package.json'
  );

  it('confirms both real app package.json files are consistent with the workshop prerequisite', () => {
    const report = checkEnginesConsistencyForFiles([controlPlanePath, appPlanePath]);
    expect(report.offending).toEqual([]);
    expect(report.isFailure).toBe(false);
  });
});
