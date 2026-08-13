/**
 * Dependency Upgrade Planner (Design Component 1).
 *
 * Produces the canonical CDK_Dependencies target set (`plan_versions`) and applies
 * it to an app's `package.json` in bump order (`apply`), capturing a
 * {@link SubstitutionRecord} for every substitution / style adjustment.
 *
 * Requirements covered: 1.1, 1.3, 1.4, 1.5, 1.6.
 *
 * Feature: codebase-modernization-refresh
 */
import type {
  VersionSet,
  SubstitutionRecord,
  PackageJson,
  AppId,
  AppliedResult,
  DependencyChange,
} from './models';

/**
 * The canonical CDK_Dependencies target values from the design's Target Version
 * Matrix. Fast-moving entries (CLI, cdk-nag, typescript, @types/node, constructs)
 * are the representative concrete values; task 1.4 resolves the final
 * `[confirm-at-exec]` values against the live registries and records them as
 * {@link SubstitutionRecord}s.
 */
const TARGET_AWS_CDK_LIB = '2.258.0';
const TARGET_AWS_CDK_CLI = '2.1031.1';
const TARGET_CONSTRUCTS = '^10.4.2';
const TARGET_CDK_NAG = '2.36.18';
const TARGET_TYPESCRIPT = '~5.9.2';
const TARGET_TYPES_NODE = '^22.10.1';
const TARGET_JEST = '^29.7.0';
const TARGET_TS_JEST = '^29.1.5';
const TARGET_TS_NODE = '^10.9.2';
const TARGET_NODE_ENGINES = '>=22.0.0 <25.0.0';
const TARGET_ECMA = 'ES2023';

/** The npm package name of the Alpha_Module whose version mirrors `aws-cdk-lib`. */
export const ALPHA_MODULE_NAME = '@aws-cdk/aws-lambda-python-alpha';

/**
 * Derive the Alpha_Module version from an `aws-cdk-lib` version by appending the
 * alpha-suffix convention (`v` -> `v-alpha.0`), e.g. `2.258.0` -> `2.258.0-alpha.0`.
 * The result is character-for-character `awsCdkLib` plus the suffix (Req 1.3).
 */
export function deriveAlphaModule(awsCdkLib: string): string {
  return `${awsCdkLib}-alpha.0`;
}

/**
 * A version spec is an "exact pin" when it names a single semantic version with no
 * range prefix (`^`, `~`, `>`, `<`, `=`), no wildcard (`x`/`*`), and no range union.
 * An optional prerelease tag (e.g. `-alpha.0`) is allowed.
 */
export function isExactPin(spec: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec.trim());
}

/**
 * Strip a leading range operator from a version spec to recover its exact form,
 * e.g. `^22.10.1` -> `22.10.1`. Used to preserve exact-pin style (Req 1.5).
 * If the spec is not reducible to an exact pin, it is returned unchanged.
 */
export function toExactPin(spec: string): string {
  const stripped = spec.trim().replace(/^[\^~>=<\s]+/, '');
  return isExactPin(stripped) ? stripped : spec.trim();
}

/**
 * Produce the canonical CDK dependency set applied identically to both apps.
 * The Alpha_Module is derived from `aws-cdk-lib` so the two never drift (Req 1.3).
 */
export function planVersions(): VersionSet {
  return {
    awsCdkLib: TARGET_AWS_CDK_LIB,
    awsCdkCli: TARGET_AWS_CDK_CLI,
    alphaModule: deriveAlphaModule(TARGET_AWS_CDK_LIB),
    constructs: TARGET_CONSTRUCTS,
    cdkNag: TARGET_CDK_NAG,
    typescript: TARGET_TYPESCRIPT,
    typesNode: TARGET_TYPES_NODE,
    jest: TARGET_JEST,
    tsJest: TARGET_TS_JEST,
    tsNode: TARGET_TS_NODE,
    nodeEngines: TARGET_NODE_ENGINES,
    ecmaTarget: TARGET_ECMA,
  };
}

/** snake_case alias matching the design's interface signature `plan_versions()`. */
export const plan_versions = planVersions;

/**
 * Map of managed CDK_Dependencies package names to the {@link VersionSet} field
 * that supplies their target version. Only these names are rewritten by `apply`;
 * any other dependency (e.g. `source-map-support`, `@types/jest`) is left untouched.
 */
const MANAGED: Record<string, keyof VersionSet> = {
  'aws-cdk-lib': 'awsCdkLib',
  'aws-cdk': 'awsCdkCli',
  [ALPHA_MODULE_NAME]: 'alphaModule',
  constructs: 'constructs',
  'cdk-nag': 'cdkNag',
  typescript: 'typescript',
  '@types/node': 'typesNode',
  jest: 'jest',
  'ts-jest': 'tsJest',
  'ts-node': 'tsNode',
};

const SECTIONS: ReadonlyArray<'dependencies' | 'devDependencies'> = [
  'dependencies',
  'devDependencies',
];

/**
 * Apply the canonical {@link VersionSet} to one app's `package.json`.
 *
 * Rewrites every managed CDK_Dependencies entry to its target version, derives the
 * Alpha_Module to exactly match `aws-cdk-lib` (Req 1.3), and preserves exact-pin
 * style for dependencies that were previously exact-pinned (Req 1.5) — recording a
 * {@link SubstitutionRecord} whenever the target value's style is adjusted to keep
 * the pin exact (Req 1.6). The source object is not mutated; a new object is returned.
 */
export function apply(app: AppId, versions: VersionSet, pkg: PackageJson): AppliedResult {
  const next: PackageJson = JSON.parse(JSON.stringify(pkg));
  const changes: DependencyChange[] = [];
  const substitutions: SubstitutionRecord[] = [];

  for (const section of SECTIONS) {
    const deps = next[section];
    if (!deps) continue;

    for (const name of Object.keys(deps)) {
      const field = MANAGED[name];
      if (!field) continue;

      const previousVersion = deps[name];
      const wasExact = isExactPin(previousVersion);
      let selectedVersion = versions[field];

      // Req 1.5: a previously exact-pinned dependency keeps the exact-pin style.
      if (wasExact && !isExactPin(selectedVersion)) {
        const requested = selectedVersion;
        selectedVersion = toExactPin(selectedVersion);
        substitutions.push({
          dependency: name,
          requestedVersion: requested,
          selectedVersion,
          reason:
            'Preserved exact-pin style: dependency was previously pinned exactly with no range prefix (Req 1.5).',
        });
      }

      if (selectedVersion !== previousVersion) {
        deps[name] = selectedVersion;
        changes.push({
          dependency: name,
          section,
          previousVersion,
          selectedVersion,
          exactPin: isExactPin(selectedVersion),
        });
      }
    }
  }

  return { app, packageJson: next, changes, substitutions };
}
