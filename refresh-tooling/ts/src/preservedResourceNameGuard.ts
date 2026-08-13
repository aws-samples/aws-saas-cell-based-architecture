/**
 * Preserved-Resource-Name Guard (Design Component 9 sub-interface `checkResourceNames()`, CC14).
 *
 * Guards the literal resource names and console-reference configuration that the
 * Workshop_Content depends on, so screenshots and step-by-step console instructions
 * remain valid across the refresh.
 *
 * Behavior (Requirements 15.1, 15.3, 15.4, 15.5):
 *   - 15.1: the literal resource names `CellDeploymentStateMachine`,
 *     `SaaS-App-Plane-Health-Dashboard`, the `cell-tenant-mapping-store` key-value
 *     store, and the DynamoDB attributes `wave_number`, `cell_max_capacity`, and
 *     `cell_size` are preserved character-for-character and case-sensitively.
 *   - 15.3: WHERE a preserved name must be renamed, a rename-impact inventory is
 *     required that lists every affected workshop step id and every affected
 *     screenshot reference, achieving 100% coverage of occurrences of the old name.
 *   - 15.4: the `us-east-1` region pin for the CloudFront key-value store and its
 *     `crossRegionReferences` configuration are preserved.
 *   - 15.5: IF the refresh would change any preserved name WITHOUT a corresponding
 *     100%-coverage rename-impact inventory, the change is REJECTED, the original
 *     name is retained unchanged, and an error indication identifying the affected
 *     resource name is emitted.
 *
 * `checkResourceNames()` is a pure function over its inputs (the set of preserved
 * names, the observed occurrences, any requested rename + its impact inventory, and
 * the observed region-pin / crossRegionReferences configuration). It performs no I/O
 * so it is unit- and property-testable (the property test is task 18.2).
 *
 * Interface (design): `checkResourceNames()`.
 *
 * Feature: codebase-modernization-refresh
 */
import type { PreservedResourceCheck } from './models';

/**
 * The literal resource names that MUST be preserved character-for-character and
 * case-sensitively across the refresh (Req 15.1).
 */
export const PRESERVED_RESOURCE_NAMES = [
  'CellDeploymentStateMachine',
  'SaaS-App-Plane-Health-Dashboard',
  'cell-tenant-mapping-store',
  'wave_number',
  'cell_max_capacity',
  'cell_size',
] as const;

/** The region pin for the CloudFront key-value store that MUST be preserved (Req 15.4). */
export const PRESERVED_REGION_PIN = 'us-east-1';

/**
 * A requested rename of a preserved resource name, together with its rename-impact
 * inventory (Req 15.2/15.3). A rename is only permitted when the inventory achieves
 * 100% coverage of occurrences of the old name across the Workshop_Content.
 */
export interface RenameRequest {
  /** the preserved (old) literal name to be renamed */
  name: string;
  /** the proposed new literal name */
  newName: string;
  /**
   * The rename-impact inventory: every affected workshop step id and every
   * affected screenshot reference (Req 15.3). Absent when no inventory was produced.
   */
  impact?: { stepIds: string[]; screenshots: string[] };
  /**
   * Total occurrences of the old name across the Workshop_Content. When provided,
   * the inventory must cover all of them for the rename to be permitted. When
   * omitted, a non-empty inventory is required as a minimum.
   */
  occurrences?: number;
  /**
   * Occurrences accounted for by the inventory. Defaults to the number of listed
   * step ids plus screenshot references when omitted.
   */
  coveredOccurrences?: number;
}

/** Inputs to {@link checkResourceNames}. All fields are optional with safe defaults. */
export interface CheckResourceNamesInput {
  /** The preserved names to guard; defaults to {@link PRESERVED_RESOURCE_NAMES}. */
  preservedNames?: readonly string[];
  /**
   * The literal name currently observed in the repository/workshop for each
   * preserved resource, keyed by the canonical preserved name. A value equal to the
   * key means the name is preserved; a differing value means it was changed; an
   * absent key means the original name is intact (assumed preserved).
   */
  observedNames?: Record<string, string>;
  /** Any requested renames of preserved names, with their impact inventories. */
  renameRequests?: RenameRequest[];
  /**
   * The observed CloudFront key-value store region pin. When omitted, the pin is
   * assumed intact (`us-east-1`).
   */
  regionPin?: string;
  /**
   * The observed `crossRegionReferences` configuration. When omitted, it is assumed
   * intact (preserved/enabled).
   */
  crossRegionReferences?: boolean;
}

/** The aggregate result of the preserved-resource-name guard (Req 15). */
export interface ResourceNameGuardReport {
  /** One {@link PreservedResourceCheck} per guarded name. */
  checks: PreservedResourceCheck[];
  /** True iff the `us-east-1` region pin is preserved (Req 15.4). */
  regionPinPreserved: boolean;
  /** True iff the `crossRegionReferences` configuration is preserved (Req 15.4). */
  crossRegionReferencesPreserved: boolean;
  /** Names whose change was rejected for lacking a 100%-coverage inventory (Req 15.5). */
  rejectedRenames: string[];
  /** Error indications identifying each rejected/violated resource name (Req 15.5). */
  errors: string[];
  /** True iff any rejection or preservation violation was recorded. */
  isFailure: boolean;
}

/**
 * True iff the rename request carries a rename-impact inventory achieving 100%
 * coverage of occurrences of the old name (Req 15.3).
 *
 * - No inventory at all → not full coverage.
 * - `occurrences` known and > 0 → covered occurrences must reach the total.
 * - `occurrences === 0` → trivially full coverage (no references to update).
 * - `occurrences` unknown → require a non-empty inventory as the minimum bar.
 */
export function hasFullCoverageInventory(request: RenameRequest): boolean {
  const impact = request.impact;
  if (!impact) return false;

  const listed = impact.stepIds.length + impact.screenshots.length;
  const listsSomething = listed > 0;

  if (request.occurrences === undefined) {
    return listsSomething;
  }
  if (request.occurrences <= 0) {
    return true;
  }
  const covered = request.coveredOccurrences ?? listed;
  return covered >= request.occurrences;
}

/**
 * Run the preserved-resource-name guard over the supplied inputs.
 *
 * For each guarded name the guard determines whether the refresh would change it
 * (an explicit rename request, or an observed literal differing from the canonical
 * name). A change is permitted only when accompanied by a 100%-coverage rename-impact
 * inventory; otherwise the change is rejected, the original name is retained, and an
 * error identifying the name is emitted (Req 15.5). The region pin and
 * `crossRegionReferences` configuration are independently confirmed preserved
 * (Req 15.4).
 */
export function checkResourceNames(
  input: CheckResourceNamesInput = {}
): ResourceNameGuardReport {
  const preservedNames = input.preservedNames ?? PRESERVED_RESOURCE_NAMES;
  const observedNames = input.observedNames ?? {};
  const renameRequests = input.renameRequests ?? [];

  const renameByName = new Map<string, RenameRequest>();
  for (const request of renameRequests) {
    renameByName.set(request.name, request);
  }

  const checks: PreservedResourceCheck[] = [];
  const rejectedRenames: string[] = [];
  const errors: string[] = [];

  for (const name of preservedNames) {
    const observed = observedNames[name];
    // Absent observation => original name intact (preserved).
    const nameUnchanged = observed === undefined || observed === name;

    const request = renameByName.get(name);
    const renameRequested = request !== undefined;

    // A "change" to a preserved name is either an explicit rename request or an
    // observed literal that no longer matches the canonical name.
    const wouldChange = renameRequested || !nameUnchanged;

    const inventoryOk = request ? hasFullCoverageInventory(request) : false;

    // Req 15.5: a change without a 100%-coverage inventory is rejected; the original
    // name is retained (found stays true) and an error identifying the name is emitted.
    const rejected = wouldChange && !inventoryOk;
    if (rejected) {
      rejectedRenames.push(name);
      if (renameRequested) {
        errors.push(
          `Rejected rename of preserved resource name "${name}"` +
            `${request?.newName ? ` to "${request.newName}"` : ''}: ` +
            `no rename-impact inventory with 100% occurrence coverage (Req 15.3, 15.5). ` +
            `Retaining the original name unchanged.`
        );
      } else {
        errors.push(
          `Preserved resource name "${name}" was changed to "${observed}" ` +
            `without a rename-impact inventory (Req 15.1, 15.5). ` +
            `Retaining the original name unchanged.`
        );
      }
    }

    // `found` reflects whether the preserved name is intact. When a change is
    // rejected the original is retained, so the name remains found. When a rename
    // is permitted by a full-coverage inventory, the name is intentionally changed.
    const found = rejected ? true : nameUnchanged;

    const check: PreservedResourceCheck = {
      name,
      found,
      renameRequested,
    };
    if (request?.impact) {
      check.renameImpact = {
        stepIds: [...request.impact.stepIds],
        screenshots: [...request.impact.screenshots],
      };
    }
    checks.push(check);
  }

  // Req 15.4: preserve the us-east-1 pin and crossRegionReferences. Absent
  // observations are treated as intact.
  const regionPinPreserved =
    input.regionPin === undefined || input.regionPin === PRESERVED_REGION_PIN;
  if (!regionPinPreserved) {
    errors.push(
      `CloudFront key-value store region pin changed from "${PRESERVED_REGION_PIN}" ` +
        `to "${input.regionPin}" (Req 15.4). The pin must be preserved.`
    );
  }

  const crossRegionReferencesPreserved =
    input.crossRegionReferences === undefined || input.crossRegionReferences === true;
  if (!crossRegionReferencesPreserved) {
    errors.push(
      `crossRegionReferences configuration for the CloudFront key-value store was ` +
        `disabled (Req 15.4). It must be preserved.`
    );
  }

  const isFailure =
    rejectedRenames.length > 0 ||
    !regionPinPreserved ||
    !crossRegionReferencesPreserved;

  return {
    checks,
    regionPinPreserved,
    crossRegionReferencesPreserved,
    rejectedRenames,
    errors,
    isFailure,
  };
}
