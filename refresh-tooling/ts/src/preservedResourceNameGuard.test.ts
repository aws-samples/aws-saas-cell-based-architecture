/**
 * Unit tests for the Preserved-Resource-Name Guard (Design Component 9 `checkResourceNames()`, CC14).
 *
 * Requirements covered: 15.1, 15.3, 15.4, 15.5.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  checkResourceNames,
  hasFullCoverageInventory,
  PRESERVED_RESOURCE_NAMES,
  PRESERVED_REGION_PIN,
  RenameRequest,
} from './preservedResourceNameGuard';

describe('checkResourceNames — defaults (Req 15.1, 15.4)', () => {
  it('passes when every preserved name is intact and config is preserved', () => {
    const report = checkResourceNames();

    expect(report.isFailure).toBe(false);
    expect(report.errors).toEqual([]);
    expect(report.rejectedRenames).toEqual([]);
    expect(report.regionPinPreserved).toBe(true);
    expect(report.crossRegionReferencesPreserved).toBe(true);
    expect(report.checks).toHaveLength(PRESERVED_RESOURCE_NAMES.length);
    for (const check of report.checks) {
      expect(check.found).toBe(true);
      expect(check.renameRequested).toBe(false);
    }
  });

  it('guards exactly the six canonical names character-for-character', () => {
    const report = checkResourceNames();
    expect(report.checks.map((c) => c.name)).toEqual([
      'CellDeploymentStateMachine',
      'SaaS-App-Plane-Health-Dashboard',
      'cell-tenant-mapping-store',
      'wave_number',
      'cell_max_capacity',
      'cell_size',
    ]);
  });
});

describe('checkResourceNames — silent change without inventory (Req 15.1, 15.5)', () => {
  it('rejects an observed literal that differs from the canonical name, retains original, emits error', () => {
    const report = checkResourceNames({
      observedNames: { wave_number: 'waveNumber' },
    });

    expect(report.isFailure).toBe(true);
    expect(report.rejectedRenames).toContain('wave_number');
    // original retained -> found stays true
    const check = report.checks.find((c) => c.name === 'wave_number')!;
    expect(check.found).toBe(true);
    expect(report.errors.some((e) => e.includes('wave_number'))).toBe(true);
  });

  it('is case-sensitive: a case-only difference is a violation', () => {
    const report = checkResourceNames({
      observedNames: { CellDeploymentStateMachine: 'celldeploymentstatemachine' },
    });
    expect(report.isFailure).toBe(true);
    expect(report.rejectedRenames).toContain('CellDeploymentStateMachine');
  });
});

describe('checkResourceNames — rename without 100% coverage (Req 15.3, 15.5)', () => {
  it('rejects a rename request lacking any impact inventory', () => {
    const report = checkResourceNames({
      renameRequests: [{ name: 'cell_size', newName: 'cellSize' }],
    });

    expect(report.isFailure).toBe(true);
    expect(report.rejectedRenames).toContain('cell_size');
    const err = report.errors.find((e) => e.includes('cell_size'));
    expect(err).toMatch(/Rejected rename/);
    expect(err).toContain('cellSize');
    // original retained
    expect(report.checks.find((c) => c.name === 'cell_size')!.found).toBe(true);
  });

  it('rejects a rename whose inventory covers fewer than all occurrences', () => {
    const report = checkResourceNames({
      renameRequests: [
        {
          name: 'cell_max_capacity',
          newName: 'cellMaxCapacity',
          impact: { stepIds: ['lab04-step-3'], screenshots: ['cap.png'] },
          occurrences: 5,
          coveredOccurrences: 2,
        },
      ],
    });
    expect(report.isFailure).toBe(true);
    expect(report.rejectedRenames).toContain('cell_max_capacity');
  });
});

describe('checkResourceNames — rename WITH 100% coverage (Req 15.3)', () => {
  it('permits a rename whose inventory achieves full occurrence coverage', () => {
    const report = checkResourceNames({
      observedNames: { 'cell-tenant-mapping-store': 'cell-tenant-map' },
      renameRequests: [
        {
          name: 'cell-tenant-mapping-store',
          newName: 'cell-tenant-map',
          impact: {
            stepIds: ['lab02-step-1', 'lab02-step-2'],
            screenshots: ['map1.png'],
          },
          occurrences: 3,
          coveredOccurrences: 3,
        },
      ],
    });

    expect(report.isFailure).toBe(false);
    expect(report.rejectedRenames).toEqual([]);
    const check = report.checks.find((c) => c.name === 'cell-tenant-mapping-store')!;
    expect(check.renameRequested).toBe(true);
    expect(check.renameImpact).toEqual({
      stepIds: ['lab02-step-1', 'lab02-step-2'],
      screenshots: ['map1.png'],
    });
    // permitted rename => name intentionally changed, not "found"
    expect(check.found).toBe(false);
  });
});

describe('checkResourceNames — region pin and crossRegionReferences (Req 15.4)', () => {
  it('flags a changed region pin', () => {
    const report = checkResourceNames({ regionPin: 'us-west-2' });
    expect(report.regionPinPreserved).toBe(false);
    expect(report.isFailure).toBe(true);
    expect(report.errors.some((e) => e.includes(PRESERVED_REGION_PIN))).toBe(true);
  });

  it('flags disabled crossRegionReferences', () => {
    const report = checkResourceNames({ crossRegionReferences: false });
    expect(report.crossRegionReferencesPreserved).toBe(false);
    expect(report.isFailure).toBe(true);
    expect(report.errors.some((e) => /crossRegionReferences/.test(e))).toBe(true);
  });

  it('treats an intact us-east-1 pin and enabled crossRegionReferences as preserved', () => {
    const report = checkResourceNames({
      regionPin: 'us-east-1',
      crossRegionReferences: true,
    });
    expect(report.regionPinPreserved).toBe(true);
    expect(report.crossRegionReferencesPreserved).toBe(true);
    expect(report.isFailure).toBe(false);
  });
});

describe('hasFullCoverageInventory', () => {
  const base: RenameRequest = { name: 'x', newName: 'y' };

  it('is false with no inventory', () => {
    expect(hasFullCoverageInventory(base)).toBe(false);
  });

  it('requires a non-empty inventory when occurrences are unknown', () => {
    expect(
      hasFullCoverageInventory({ ...base, impact: { stepIds: [], screenshots: [] } })
    ).toBe(false);
    expect(
      hasFullCoverageInventory({ ...base, impact: { stepIds: ['s1'], screenshots: [] } })
    ).toBe(true);
  });

  it('treats zero occurrences as trivially full coverage', () => {
    expect(
      hasFullCoverageInventory({
        ...base,
        impact: { stepIds: [], screenshots: [] },
        occurrences: 0,
      })
    ).toBe(true);
  });

  it('requires covered occurrences to reach the total', () => {
    expect(
      hasFullCoverageInventory({
        ...base,
        impact: { stepIds: ['s1'], screenshots: ['p1'] },
        occurrences: 2,
      })
    ).toBe(true);
    expect(
      hasFullCoverageInventory({
        ...base,
        impact: { stepIds: ['s1'], screenshots: [] },
        occurrences: 2,
      })
    ).toBe(false);
  });
});
