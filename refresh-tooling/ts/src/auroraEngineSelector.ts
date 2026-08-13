/**
 * Aurora Engine Selector (Design Component 5, CC5).
 *
 * Selects a supported `AuroraPostgresEngineVersion`, confirms the selection is
 * present in the target `aws-cdk-lib` `AuroraPostgresEngineVersion` enumeration,
 * and produces an {@link EngineDecision} record.
 *
 * Behavior (Requirements 5.1–5.4):
 *   - 5.1: the selected version is a non-deprecated, non-EOL Aurora PostgreSQL
 *     version equal to or newer than the currently configured `VER_15_10`.
 *   - 5.2: the decision records the selection rationale (selected, current, basis).
 *   - 5.3: the selection is confirmed present in the `aws-cdk-lib`
 *     `AuroraPostgresEngineVersion` enumeration (enum-presence check).
 *   - 5.4: IF the selection is NOT present in the enum, the change is REJECTED:
 *     the currently configured version is retained as the effective version and
 *     an indication identifying the unsupported version is recorded in `basis`.
 *     `enumPresent` is set to `false`.
 *
 * The enum membership is supplied as an explicit list of member names so the
 * selector is testable without depending on `aws-cdk-lib`. {@link loadAuroraEnumMembers}
 * is provided to derive that list from an installed `aws-cdk-lib` at execution time.
 *
 * Interface (design): `selectEngine() -> EngineDecision`.
 *
 * Feature: codebase-modernization-refresh
 */
import type { EngineDecision } from './models';

/** The currently configured Aurora engine version in `RdsPostgresConstruct.ts`. */
export const CURRENT_ENGINE_VERSION = 'VER_15_10';

/**
 * The target Aurora engine version selected during planning. Staying within major
 * 15 keeps the tenant SQL scripts behavior-identical (Req 16) while moving to the
 * latest supported 15.x minor (design Target Version Matrix).
 */
export const SELECTED_ENGINE_VERSION = 'VER_15_17';

/**
 * Canonical SQL-script compatibility determination (Req 5.5, CC5).
 *
 * The bump VER_15_10 -> VER_15_17 is a same-major (15) minor upgrade; PostgreSQL
 * minor releases ship bug/security fixes only and never change SQL syntax or
 * behavior. Direct inspection of both tenant scripts confirms each uses only
 * standard, long-stable DDL/DCL with no version-gated features:
 *   - tenant-provisioning.sql: CREATE SCHEMA / CREATE TABLE (INTEGER/TEXT/NUMERIC
 *     columns) / CREATE USER ... WITH PASSWORD / GRANT CONNECT|USAGE|ALL PRIVILEGES.
 *   - tenant-de-provisioning.sql: DROP DATABASE / DROP USER.
 * Both are therefore COMPATIBLE with the selected engine version.
 */
export const TENANT_SQL_COMPAT: { script: string; compatible: boolean }[] = [
  { script: 'tenant-provisioning.sql', compatible: true },
  { script: 'tenant-de-provisioning.sql', compatible: true },
];

/**
 * Canonical instance-class / DB-parameter changes required by the engine bump
 * (Req 5.6). A within-major (15.x) minor upgrade requires no instance-class change
 * and introduces no changed/added DB parameter-group settings, so the list is empty.
 */
export const ENGINE_SETTING_CHANGES: { setting: string; value: string }[] = [];

/** Parameters for {@link selectEngine}. */
export interface SelectEngineInput {
  /** Member names present in the target `aws-cdk-lib` `AuroraPostgresEngineVersion` enum. */
  availableEnumMembers: string[];
  /** Defaults to {@link SELECTED_ENGINE_VERSION}. */
  selected?: string;
  /** Defaults to {@link CURRENT_ENGINE_VERSION}. */
  current?: string;
  /** Optional selection rationale; a default basis is generated when omitted. */
  basis?: string;
  /** SQL-script compatibility determinations (Req 5.5); defaults to {@link TENANT_SQL_COMPAT}. */
  sqlCompat?: { script: string; compatible: boolean }[];
  /** Required instance-class / parameter changes (Req 5.6); defaults to {@link ENGINE_SETTING_CHANGES}. */
  settingChanges?: { setting: string; value: string }[];
}

/**
 * Parse a `VER_<major>_<minor>` enum member name into a comparable numeric tuple.
 * Returns null when the name is not in the expected shape.
 */
function parseVer(name: string): { major: number; minor: number } | null {
  const m = /^VER_(\d+)_(\d+)$/.exec(name);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** True iff `a` is greater than or equal to `b` by (major, minor) precedence. */
function gte(a: { major: number; minor: number }, b: { major: number; minor: number }): boolean {
  if (a.major !== b.major) return a.major > b.major;
  return a.minor >= b.minor;
}

/**
 * Select the Aurora engine version and confirm enum presence.
 *
 * When the selection is present in the enum the selection is accepted and becomes
 * the effective version. When it is absent the change is rejected, the current
 * version is retained as the effective version (see {@link effectiveEngineVersion}),
 * and the rejection indication is recorded in `basis` (Req 5.4).
 */
export function selectEngine(input: SelectEngineInput): EngineDecision {
  const current = input.current ?? CURRENT_ENGINE_VERSION;
  const selected = input.selected ?? SELECTED_ENGINE_VERSION;
  const available = new Set(input.availableEnumMembers);

  const enumPresent = available.has(selected);

  const selVer = parseVer(selected);
  const curVer = parseVer(current);
  const notOlderThanCurrent =
    selVer !== null && curVer !== null ? gte(selVer, curVer) : true;

  let basis: string;
  if (input.basis) {
    basis = input.basis;
  } else if (enumPresent) {
    basis =
      `Selected ${selected}: present in the aws-cdk-lib AuroraPostgresEngineVersion ` +
      `enum and ${notOlderThanCurrent ? 'not older than' : 'OLDER THAN'} the current ` +
      `${current}. Remaining within the same major preserves tenant SQL behavior (Req 5.1–5.3).`;
  } else {
    // Req 5.4: reject; retain current; identify the unsupported version.
    basis =
      `REJECTED: selected version ${selected} is NOT present in the target aws-cdk-lib ` +
      `AuroraPostgresEngineVersion enumeration. Retaining the currently configured ` +
      `${current} (Req 5.4).`;
  }

  return {
    current,
    selected,
    basis,
    enumPresent,
    // Req 5.5 / 5.6: default to the canonical CC5 determination when the caller
    // does not supply explicit records, so selectEngine() emits the recorded
    // SQL-compatibility and setting-change determination by default.
    sqlCompat: input.sqlCompat ?? TENANT_SQL_COMPAT,
    settingChanges: input.settingChanges ?? ENGINE_SETTING_CHANGES,
  };
}

/**
 * The version that must actually be applied to `RdsPostgresConstruct.ts` given a
 * decision: the selection when it is enum-present, otherwise the retained current
 * version (Req 5.4).
 */
export function effectiveEngineVersion(decision: EngineDecision): string {
  return decision.enumPresent ? decision.selected : decision.current;
}

/**
 * Derive the set of `AuroraPostgresEngineVersion` enum member names from an
 * installed `aws-cdk-lib`. Returns null when `aws-cdk-lib` cannot be resolved
 * (e.g. not installed in this workspace), so callers can fall back to an explicit
 * member list. Static `VER_*` members are collected from the enum class.
 */
export function loadAuroraEnumMembers(moduleId = 'aws-cdk-lib/aws-rds'): string[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rds = require(moduleId) as {
      AuroraPostgresEngineVersion?: Record<string, unknown>;
    };
    const enumObj = rds.AuroraPostgresEngineVersion;
    if (!enumObj) return null;
    return Object.keys(enumObj).filter((k) => /^VER_\d+_\d+$/.test(k));
  } catch {
    return null;
  }
}
