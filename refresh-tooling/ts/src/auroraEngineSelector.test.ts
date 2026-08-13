/**
 * Unit tests for the Aurora Engine Selector (Design Component 5, CC5).
 *
 * Requirements covered: 5.1, 5.2, 5.3, 5.4.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  selectEngine,
  effectiveEngineVersion,
  CURRENT_ENGINE_VERSION,
  SELECTED_ENGINE_VERSION,
} from './auroraEngineSelector';
import { engineDecision as plannedDecision } from './assumption-log';

/** A representative enum-member list covering Aurora PostgreSQL 15.x. */
const ENUM_WITH_15_17 = [
  'VER_15_2',
  'VER_15_4',
  'VER_15_10',
  'VER_15_13',
  'VER_15_17',
  'VER_16_13',
  'VER_17_9',
];

/** The same list with the target absent (placeholder removed). */
const ENUM_WITHOUT_15_17 = ENUM_WITH_15_17.filter((v) => v !== 'VER_15_17');

describe('selectEngine — enum present (Req 5.1, 5.2, 5.3)', () => {
  it('accepts VER_15_17 when present and records rationale', () => {
    const decision = selectEngine({ availableEnumMembers: ENUM_WITH_15_17 });

    expect(decision.enumPresent).toBe(true);
    expect(decision.selected).toBe(SELECTED_ENGINE_VERSION);
    expect(decision.current).toBe(CURRENT_ENGINE_VERSION);
    expect(decision.basis).toMatch(/present/i);
    expect(effectiveEngineVersion(decision)).toBe('VER_15_17');
  });

  it('carries through SQL-compat and setting-change records (Req 5.2)', () => {
    const decision = selectEngine({
      availableEnumMembers: ENUM_WITH_15_17,
      sqlCompat: [{ script: 'tenant-provisioning.sql', compatible: true }],
      settingChanges: [],
    });
    expect(decision.sqlCompat).toEqual([
      { script: 'tenant-provisioning.sql', compatible: true },
    ]);
  });

  it('selection is not older than the current version', () => {
    const decision = selectEngine({ availableEnumMembers: ENUM_WITH_15_17 });
    expect(decision.basis).not.toMatch(/OLDER THAN/);
  });
});

describe('selectEngine — enum absent (Req 5.4)', () => {
  it('rejects an absent selection, retains the current version, and flags the unsupported version', () => {
    const decision = selectEngine({ availableEnumMembers: ENUM_WITHOUT_15_17 });

    expect(decision.enumPresent).toBe(false);
    // current version is retained as the effective version
    expect(effectiveEngineVersion(decision)).toBe(CURRENT_ENGINE_VERSION);
    expect(decision.basis).toMatch(/REJECTED/);
    expect(decision.basis).toContain(SELECTED_ENGINE_VERSION);
  });

  it('rejects an enum-absent placeholder version', () => {
    const decision = selectEngine({
      availableEnumMembers: ENUM_WITH_15_17,
      selected: 'VER_15_999',
    });
    expect(decision.enumPresent).toBe(false);
    expect(effectiveEngineVersion(decision)).toBe(CURRENT_ENGINE_VERSION);
  });
});

describe('selectEngine — consistency with the planning record', () => {
  it('matches the assumption-log EngineDecision when the enum contains the selection', () => {
    const decision = selectEngine({
      availableEnumMembers: ENUM_WITH_15_17,
      basis: plannedDecision.basis,
      sqlCompat: plannedDecision.sqlCompat,
      settingChanges: plannedDecision.settingChanges,
    });
    expect(decision.selected).toBe(plannedDecision.selected);
    expect(decision.current).toBe(plannedDecision.current);
    expect(decision.enumPresent).toBe(plannedDecision.enumPresent);
  });
});

describe('RdsPostgresConstruct — applied engine version (Req 5.3)', () => {
  const constructPath = path.resolve(
    __dirname,
    '../../../lib/application-plane/cell-app-plane/cdk/lib/RdsPostgresConstruct.ts'
  );

  it('uses the resolved VER_15_17 and no longer references VER_15_10 in the engine declaration', () => {
    const source = fs.readFileSync(constructPath, 'utf8');
    expect(source).toContain('rds.AuroraPostgresEngineVersion.VER_15_17');
    expect(source).not.toContain('version: rds.AuroraPostgresEngineVersion.VER_15_10');
  });
});
