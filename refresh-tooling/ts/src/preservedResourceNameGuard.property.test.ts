/**
 * Property-based tests for the Preserved-Resource-Name Guard
 * (Design Component 9 `checkResourceNames()`, CC14).
 *
 * Feature: codebase-modernization-refresh, Property 12
 *
 * Property 12: Preserved resource names are immutable without a rename inventory
 * Validates: Requirements 15.1, 15.5
 *
 * Over arbitrary inputs — random subsets of the preserved names that are
 * silently changed (an observed literal differing from the canonical name) or
 * the subject of a rename request whose rename-impact inventory has varying
 * coverage (none, partial, or 100%), combined with adversarial region-pin and
 * `crossRegionReferences` variations — `checkResourceNames` MUST:
 *
 *   - REJECT every change to a preserved name that lacks a 100%-coverage
 *     rename-impact inventory: the name appears in `rejectedRenames`, the
 *     original is retained (`found` stays true), an error identifying the name
 *     is emitted, and `isFailure` is true (Req 15.1, 15.5); and
 *   - conversely, PERMIT a rename accompanied by a full-coverage inventory: the
 *     name is NOT in `rejectedRenames` (Req 15.2/15.3 — the escape hatch that
 *     keeps 15.5 from being vacuous).
 *
 * The expected rejection/permission set is derived independently from the
 * requirement text (from the action chosen for each name), so the property is a
 * genuine cross-check of the guard rather than a tautology.
 */
import fc from 'fast-check';
import {
  checkResourceNames,
  PRESERVED_RESOURCE_NAMES,
  PRESERVED_REGION_PIN,
} from './preservedResourceNameGuard';

/* ------------------------------- Generators ----------------------------------- */

/** A literal guaranteed to differ from `name` (case-sensitively) — Req 15.1. */
const differentLiteralArb = (name: string) =>
  fc
    .oneof(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.constant(name.toUpperCase()),
      fc.constant(name.toLowerCase()),
      fc.constant(`${name}-v2`),
      fc.constant(name.replace(/[-_]/g, ''))
    )
    .map((candidate) => (candidate === name ? `${name}_x` : candidate));

const newNameArb = fc.string({ minLength: 1, maxLength: 12 });

const impactArb = fc.record({
  stepIds: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 5 }),
  screenshots: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 5 }),
});

/**
 * The action applied to a single preserved name. Each variant encodes whether
 * the guard MUST reject it (a change lacking full coverage) or permit it (a
 * rename with full coverage).
 */
const actionArbFor = (name: string) =>
  fc.oneof(
    // No change at all -> not a violation.
    fc.constant({ kind: 'unchanged' as const }),
    // Silent observed change without any inventory -> MUST be rejected (15.1/15.5).
    differentLiteralArb(name).map((observed) => ({
      kind: 'silent-change' as const,
      observed,
    })),
    // Rename request with no inventory -> MUST be rejected (15.5).
    newNameArb.map((newName) => ({
      kind: 'rename-no-inventory' as const,
      newName,
    })),
    // Rename request whose inventory covers fewer than all occurrences -> rejected.
    fc
      .record({
        newName: newNameArb,
        impact: impactArb,
        occurrences: fc.integer({ min: 2, max: 10 }),
        coveredDelta: fc.integer({ min: 0, max: 9 }),
      })
      .map(({ newName, impact, occurrences, coveredDelta }) => ({
        kind: 'rename-partial' as const,
        newName,
        impact,
        occurrences,
        covered: Math.max(0, occurrences - 1 - (coveredDelta % occurrences)),
      })),
    // Rename request with a 100%-coverage inventory -> PERMITTED (15.2/15.3).
    fc
      .record({
        newName: newNameArb,
        impact: impactArb,
        occurrences: fc.integer({ min: 1, max: 10 }),
        alsoObserve: fc.boolean(),
      })
      .map(({ newName, impact, occurrences, alsoObserve }) => ({
        kind: 'rename-full' as const,
        newName,
        impact,
        occurrences,
        covered: occurrences,
        alsoObserve,
      }))
  );

const actionsArb = fc.record(
  Object.fromEntries(PRESERVED_RESOURCE_NAMES.map((n) => [n, actionArbFor(n)]))
);

const regionPinArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(PRESERVED_REGION_PIN),
  fc.constantFrom('us-west-2', 'eu-west-1', 'ap-southeast-2')
);

const crossRegionArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(true),
  fc.constant(false)
);

type Action = { kind: string; [k: string]: unknown };

function buildScenario(
  actions: Record<string, Action>,
  regionPin: string | undefined,
  crossRegionReferences: boolean | undefined
) {
  const observedNames: Record<string, string> = {};
  const renameRequests: Array<{
    name: string;
    newName: string;
    impact?: { stepIds: string[]; screenshots: string[] };
    occurrences?: number;
    coveredOccurrences?: number;
  }> = [];
  const expectedRejected = new Set<string>();
  const expectedPermitted = new Set<string>();

  for (const name of PRESERVED_RESOURCE_NAMES) {
    const a = actions[name] as any;
    switch (a.kind) {
      case 'unchanged':
        break;
      case 'silent-change':
        observedNames[name] = a.observed;
        expectedRejected.add(name);
        break;
      case 'rename-no-inventory':
        renameRequests.push({ name, newName: a.newName });
        expectedRejected.add(name);
        break;
      case 'rename-partial':
        renameRequests.push({
          name,
          newName: a.newName,
          impact: a.impact,
          occurrences: a.occurrences,
          coveredOccurrences: a.covered,
        });
        expectedRejected.add(name);
        break;
      case 'rename-full':
        renameRequests.push({
          name,
          newName: a.newName,
          impact: a.impact,
          occurrences: a.occurrences,
          coveredOccurrences: a.covered,
        });
        if (a.alsoObserve) observedNames[name] = a.newName;
        expectedPermitted.add(name);
        break;
    }
  }

  return {
    input: { observedNames, renameRequests, regionPin, crossRegionReferences },
    expectedRejected,
    expectedPermitted,
  };
}

/* --------------------------------- Properties --------------------------------- */

describe('Feature: codebase-modernization-refresh, Property 12 — Preserved resource names are immutable without a rename inventory', () => {
  it('rejects every change lacking a 100%-coverage inventory and permits every full-coverage rename (Req 15.1, 15.5)', () => {
    fc.assert(
      fc.property(
        actionsArb,
        regionPinArb,
        crossRegionArb,
        (actions, regionPin, crossRegion) => {
          const { input, expectedRejected, expectedPermitted } = buildScenario(
            actions as Record<string, Action>,
            regionPin,
            crossRegion
          );

          const report = checkResourceNames(input);

          // Req 15.5: rejected set is exactly the changes lacking full coverage.
          expect(new Set(report.rejectedRenames)).toEqual(expectedRejected);

          for (const name of expectedRejected) {
            // Original retained -> the preserved name remains "found".
            const check = report.checks.find((c) => c.name === name)!;
            expect(check.found).toBe(true);
            // An error indication identifying the affected name is emitted.
            expect(report.errors.some((e) => e.includes(name))).toBe(true);
          }

          // Converse: a full-coverage rename is permitted (never rejected).
          for (const name of expectedPermitted) {
            expect(report.rejectedRenames).not.toContain(name);
            const check = report.checks.find((c) => c.name === name)!;
            expect(check.renameRequested).toBe(true);
          }

          // isFailure reflects rejections plus the independent region-pin /
          // crossRegionReferences guards (Req 15.4 contributes to failure too).
          const regionPinBad =
            regionPin !== undefined && regionPin !== PRESERVED_REGION_PIN;
          const crossBad = crossRegion === false;
          expect(report.isFailure).toBe(
            expectedRejected.size > 0 || regionPinBad || crossBad
          );
        }
      ),
      { numRuns: 300 }
    );
  });

  it('ALWAYS rejects a silent change to any subset of preserved names, retaining the originals (Req 15.1, 15.5)', () => {
    // A non-empty subset of names is changed in-place with no inventory.
    const subsetArb = fc
      .subarray([...PRESERVED_RESOURCE_NAMES], { minLength: 1 })
      .chain((names) =>
        fc
          .tuple(...names.map((n) => differentLiteralArb(n)))
          .map((observedValues) => {
            const observedNames: Record<string, string> = {};
            names.forEach((n, i) => (observedNames[n] = observedValues[i]));
            return { names, observedNames };
          })
      );

    fc.assert(
      fc.property(subsetArb, ({ names, observedNames }) => {
        const report = checkResourceNames({ observedNames });
        expect(report.isFailure).toBe(true);
        for (const name of names) {
          expect(report.rejectedRenames).toContain(name);
          // Original name retained unchanged.
          expect(report.checks.find((c) => c.name === name)!.found).toBe(true);
          expect(report.errors.some((e) => e.includes(name))).toBe(true);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('ALWAYS permits a rename whose inventory achieves full occurrence coverage (Req 15.2/15.3, keeps 15.5 non-vacuous)', () => {
    const fullRenameArb = fc
      .subarray([...PRESERVED_RESOURCE_NAMES], { minLength: 1 })
      .chain((names) =>
        fc
          .tuple(
            ...names.map((n) =>
              fc.record({
                newName: newNameArb,
                impact: impactArb,
                occurrences: fc.integer({ min: 0, max: 10 }),
              })
            )
          )
          .map((specs) => ({ names, specs }))
      );

    fc.assert(
      fc.property(fullRenameArb, ({ names, specs }) => {
        const renameRequests = names.map((name, i) => ({
          name,
          newName: specs[i].newName,
          impact: specs[i].impact,
          occurrences: specs[i].occurrences,
          coveredOccurrences: specs[i].occurrences,
        }));
        const report = checkResourceNames({ renameRequests });
        for (const name of names) {
          expect(report.rejectedRenames).not.toContain(name);
        }
        // No rejected renames means the guard does not fail on name grounds.
        expect(report.rejectedRenames).toEqual([]);
        expect(report.isFailure).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});
