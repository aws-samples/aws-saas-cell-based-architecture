/**
 * Scaffold smoke test: confirms the TypeScript + Jest + fast-check toolchain is wired
 * up and the shared data models are importable and structurally usable.
 *
 * Feature: codebase-modernization-refresh
 */
import fc from 'fast-check';
import type {
  VersionSet,
  LockstepReport,
  LineAnchor,
  VerificationReport,
} from './index';

describe('refresh-tooling scaffold', () => {
  it('constructs a VersionSet from the shared data model', () => {
    const vs: VersionSet = {
      awsCdkLib: '2.258.0',
      awsCdkCli: '2.1031.1',
      alphaModule: '2.258.0-alpha.0',
      constructs: '^10.4.2',
      cdkNag: '2.36.18',
      typescript: '~5.9.2',
      typesNode: '^22.10.1',
      jest: '^29.7.0',
      tsJest: '^29.1.5',
      tsNode: '^10.9.2',
      nodeEngines: '>=22.0.0 <25.0.0',
      ecmaTarget: 'ES2023',
    };
    expect(vs.alphaModule).toBe(`${vs.awsCdkLib}-alpha.0`);
  });

  it('models a passing VerificationReport', () => {
    const report: VerificationReport = {
      steps: [{ name: 'install', app: 'control-plane', exitStatus: 'success' }],
      releaseStatus: 'releasable',
    };
    expect(report.steps).toHaveLength(1);
    expect(report.releaseStatus).toBe('releasable');
  });

  it('fast-check generator runs and data models accept arbitrary inputs', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const lockstep: LockstepReport = {
          matched: [a],
          divergent: a === b ? [] : [{ name: a, controlPlane: a, appPlane: b }],
          missing: [],
          isFailure: a !== b,
        };
        const anchor: LineAnchor = {
          workshopFile: 'lab01.md',
          anchorKind: 'lineNumberStart',
          sourceFile: 'CellStack.ts',
          recordedLine: 1,
          targetRegionMarker: b,
          status: 'unchanged',
        };
        return lockstep.isFailure === (a !== b) && anchor.recordedLine === 1;
      }),
      { numRuns: 100 }
    );
  });
});
