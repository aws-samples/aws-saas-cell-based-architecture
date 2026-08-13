/**
 * Property-based tests for the Dependency Upgrade Planner (Design Component 1).
 *
 * Feature: codebase-modernization-refresh, Property 1
 *
 * Property 1: CDK version derivation and two-app lockstep
 * Validates: Requirements 1.3, 2.1, 2.3, 2.4, 2.5
 *
 * Two sub-properties are verified across arbitrary inputs (>= 100 runs each):
 *
 *  (1) Alpha-module derivation (Req 1.3): for any aws-cdk-lib version string, the
 *      derived Alpha_Module is character-for-character `awsCdkLib + "-alpha.0"`.
 *      The same identity holds for the planned VersionSet.
 *
 *  (2) Two-app lockstep (Req 2.1, 2.3, 2.4, 2.5): applying the same VersionSet to
 *      two arbitrary `package.json` structures yields an identical resolved version
 *      string for every CDK_Dependencies entry across both apps — so a cross-app
 *      comparison never reports a divergent (Req 2.4) or missing (Req 2.5) entry.
 */
import fc from 'fast-check';
import {
  planVersions,
  apply,
  deriveAlphaModule,
  isExactPin,
  ALPHA_MODULE_NAME,
} from './dependencyUpgradePlanner';
import type { PackageJson, VersionSet } from './models';

/** CDK_Dependencies per the requirements glossary (the lockstep-managed set). */
const CDK_DEPENDENCIES = [
  'aws-cdk-lib',
  'aws-cdk',
  ALPHA_MODULE_NAME,
  'constructs',
  'cdk-nag',
] as const;

type Section = 'dependencies' | 'devDependencies';

/** Arbitrary exact semantic version, e.g. "2.258.0". */
const semverArb = fc
  .tuple(fc.nat({ max: 40 }), fc.nat({ max: 400 }), fc.nat({ max: 400 }))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/**
 * Arbitrary prior version spec: an exact pin or a range-prefixed spec. This spans
 * the real input space (some CDK deps are exact-pinned, others use caret/tilde).
 */
const priorSpecArb = fc
  .tuple(semverArb, fc.constantFrom('', '^', '~', '>=', '>'))
  .map(([version, prefix]) => `${prefix}${version}`);

/** Arbitrary unmanaged dependency names that never collide with CDK_Dependencies. */
const unmanagedNameArb = fc
  .tuple(
    fc.constantFrom('lib', 'pkg', 'tool', 'util', '@scope/mod', 'helper'),
    fc.nat({ max: 9999 })
  )
  .map(([base, n]) => `${base}-${n}`);

const unmanagedDepsArb = fc.dictionary(unmanagedNameArb, priorSpecArb, { maxKeys: 6 });

/** Per-app layout: which section each managed dep lives in, plus unmanaged noise. */
const appLayoutArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 24 }),
  version: semverArb,
  sections: fc.record(
    Object.fromEntries(
      CDK_DEPENDENCIES.map((n) => [n, fc.constantFrom('dependencies', 'devDependencies')])
    ) as Record<(typeof CDK_DEPENDENCIES)[number], fc.Arbitrary<Section>>
  ),
  extraDeps: unmanagedDepsArb,
  extraDevDeps: unmanagedDepsArb,
});

interface AppLayout {
  name: string;
  version: string;
  sections: Record<(typeof CDK_DEPENDENCIES)[number], Section>;
  extraDeps: Record<string, string>;
  extraDevDeps: Record<string, string>;
}

/**
 * Build a package.json from a layout and a shared map of CDK_Dependencies prior
 * specs. Both apps declare the same CDK_Dependencies set (the realistic lockstep
 * precondition: the two apps are kept consistent on their CDK declarations) while
 * differing freely in section placement, unmanaged deps, name, and version.
 */
function buildPackageJson(
  layout: AppLayout,
  sharedPrior: Record<string, string>
): PackageJson {
  const pkg: PackageJson = {
    name: layout.name,
    version: layout.version,
    dependencies: { ...layout.extraDeps },
    devDependencies: { ...layout.extraDevDeps },
  };
  for (const name of CDK_DEPENDENCIES) {
    const section = layout.sections[name];
    pkg[section]![name] = sharedPrior[name];
  }
  return pkg;
}

/** Resolve a dependency's version string from whichever section declares it. */
function resolvedVersion(pkg: PackageJson, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
}

describe('Feature: codebase-modernization-refresh, Property 1 — CDK version derivation and two-app lockstep', () => {
  it('(1) derives the Alpha_Module as exactly aws-cdk-lib + "-alpha.0" for any version (Req 1.3)', () => {
    fc.assert(
      fc.property(semverArb, (awsCdkLib) => {
        const derived = deriveAlphaModule(awsCdkLib);
        // Character-for-character identity: prefix is the exact input, suffix fixed.
        expect(derived).toBe(`${awsCdkLib}-alpha.0`);
        expect(derived.startsWith(awsCdkLib)).toBe(true);
        expect(derived.slice(awsCdkLib.length)).toBe('-alpha.0');
        // An exact-pinned aws-cdk-lib yields an exact-pinned Alpha_Module.
        if (isExactPin(awsCdkLib)) {
          expect(isExactPin(derived)).toBe(true);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('(1) planned VersionSet always satisfies alphaModule === awsCdkLib + "-alpha.0" (Req 1.3)', () => {
    const vs: VersionSet = planVersions();
    expect(vs.alphaModule).toBe(`${vs.awsCdkLib}-alpha.0`);
  });

  it('(2) applying one VersionSet to two arbitrary apps yields identical resolved CDK_Dependencies strings (Req 2.1, 2.3, 2.4, 2.5)', () => {
    const vs: VersionSet = planVersions();

    fc.assert(
      fc.property(
        appLayoutArb,
        appLayoutArb,
        // Shared prior pin specs for the CDK_Dependencies, declared consistently
        // across both apps (the realistic lockstep precondition).
        fc.dictionary(
          fc.constantFrom(...CDK_DEPENDENCIES),
          priorSpecArb,
          { minKeys: CDK_DEPENDENCIES.length }
        ),
        (layoutA, layoutB, sharedPriorPartial) => {
          // Ensure every managed dep has a prior spec for both apps.
          const sharedPrior: Record<string, string> = {};
          for (const name of CDK_DEPENDENCIES) {
            sharedPrior[name] = sharedPriorPartial[name] ?? '1.0.0';
          }

          const pkgA = buildPackageJson(layoutA, sharedPrior);
          const pkgB = buildPackageJson(layoutB, sharedPrior);

          const appliedA = apply('control-plane', vs, pkgA).packageJson;
          const appliedB = apply('app-plane', vs, pkgB).packageJson;

          for (const name of CDK_DEPENDENCIES) {
            const rA = resolvedVersion(appliedA, name);
            const rB = resolvedVersion(appliedB, name);
            // Neither app drops the entry (Req 2.5: no missing entry).
            expect(rA).toBeDefined();
            expect(rB).toBeDefined();
            // Identical resolved string across both apps (Req 2.1, 2.3, 2.4).
            expect(rA).toBe(rB);
          }

          // The Alpha_Module resolves in lockstep to aws-cdk-lib + suffix in both apps.
          const alphaA = resolvedVersion(appliedA, ALPHA_MODULE_NAME);
          const libA = resolvedVersion(appliedA, 'aws-cdk-lib');
          expect(alphaA).toBe(`${libA}-alpha.0`);
        }
      ),
      { numRuns: 200 }
    );
  });
});
