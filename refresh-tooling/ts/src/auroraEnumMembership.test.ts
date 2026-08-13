/**
 * Focused unit tests for Aurora PostgreSQL engine enum membership (CC5).
 *
 * Task 6.3 — verify the enum-membership accept/reject contract of
 * {@link selectEngine}:
 *   - Req 5.3: a selection present in the target `aws-cdk-lib`
 *     `AuroraPostgresEngineVersion` enumeration is ACCEPTED and becomes the
 *     effective engine version.
 *   - Req 5.4: a selection ABSENT from the enumeration (an absent placeholder
 *     version) is REJECTED — the currently configured version is retained as the
 *     effective version and `enumPresent` is `false`.
 *
 * These cases isolate the membership decision specifically; broader rationale and
 * applied-construct assertions live in `auroraEngineSelector.test.ts`. Describe and
 * test names here are intentionally distinct to avoid collisions.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  selectEngine,
  effectiveEngineVersion,
  CURRENT_ENGINE_VERSION,
  SELECTED_ENGINE_VERSION,
} from './auroraEngineSelector';

/**
 * Enum member list that INCLUDES the target VER_15_17, alongside neighboring 15.x
 * minors and newer majors — a realistic slice of `AuroraPostgresEngineVersion`.
 */
const ENUM_MEMBERS_INCLUDING_TARGET = [
  'VER_15_4',
  'VER_15_10',
  'VER_15_13',
  'VER_15_17',
  'VER_16_8',
  'VER_17_4',
];

describe('Aurora enum membership — accept present version (Req 5.3)', () => {
  it('accepts VER_15_17 when it is present in the supplied enum members', () => {
    const decision = selectEngine({
      availableEnumMembers: ENUM_MEMBERS_INCLUDING_TARGET,
    });

    expect(decision.enumPresent).toBe(true);
    expect(decision.selected).toBe('VER_15_17');
    expect(decision.selected).toBe(SELECTED_ENGINE_VERSION);
    expect(effectiveEngineVersion(decision)).toBe('VER_15_17');
  });

  it('treats the present selection as the effective engine version (not the current one)', () => {
    const decision = selectEngine({
      availableEnumMembers: ENUM_MEMBERS_INCLUDING_TARGET,
    });

    expect(effectiveEngineVersion(decision)).not.toBe(CURRENT_ENGINE_VERSION);
    expect(effectiveEngineVersion(decision)).toBe(decision.selected);
  });
});

describe('Aurora enum membership — reject absent placeholder version (Req 5.4)', () => {
  it('rejects an absent placeholder version and retains the current version as effective', () => {
    const decision = selectEngine({
      availableEnumMembers: ENUM_MEMBERS_INCLUDING_TARGET,
      selected: 'VER_15_99', // placeholder that is not a real enum member
    });

    expect(decision.enumPresent).toBe(false);
    expect(effectiveEngineVersion(decision)).toBe(CURRENT_ENGINE_VERSION);
  });

  it('rejects the target when the enum omits VER_15_17, keeping the current version', () => {
    const enumWithoutTarget = ENUM_MEMBERS_INCLUDING_TARGET.filter(
      (v) => v !== 'VER_15_17'
    );

    const decision = selectEngine({ availableEnumMembers: enumWithoutTarget });

    expect(decision.enumPresent).toBe(false);
    expect(effectiveEngineVersion(decision)).toBe(CURRENT_ENGINE_VERSION);
    expect(decision.basis).toMatch(/REJECTED/);
    expect(decision.basis).toContain(SELECTED_ENGINE_VERSION);
  });

  it('rejects against an empty enum (no members available)', () => {
    const decision = selectEngine({ availableEnumMembers: [] });

    expect(decision.enumPresent).toBe(false);
    expect(effectiveEngineVersion(decision)).toBe(CURRENT_ENGINE_VERSION);
  });
});
