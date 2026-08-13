/**
 * Lockstep Comparator (Design Component 2).
 *
 * Verifies that both CDK apps (Control_Plane_App and App_Plane_App) resolve every
 * CDK_Dependencies entry to one identical version string. Any divergent or missing
 * entry marks a verification failure; per Req 2.6 the caller must then retain the
 * pre-upgrade versions of BOTH apps without applying partial changes.
 *
 * Requirements covered: 2.3, 2.4, 2.5, 2.6.
 *
 * Interface (design): `compare(controlPlane, appPlane) -> LockstepReport`.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import type { LockstepReport, PackageJson, AppId } from './models';
import { ALPHA_MODULE_NAME } from './dependencyUpgradePlanner';

/**
 * The canonical CDK_Dependencies names that must resolve identically across both
 * apps (Glossary: CDK_Dependencies). These are compared regardless of whether they
 * live in `dependencies` or `devDependencies`.
 */
export const CDK_DEPENDENCIES: readonly string[] = [
  'aws-cdk-lib',
  'aws-cdk',
  ALPHA_MODULE_NAME,
  'constructs',
  'cdk-nag',
];

/**
 * Resolve a dependency's declared version string from a `package.json`, searching
 * `dependencies` first and then `devDependencies`. Returns `undefined` when the
 * dependency is absent from both sections.
 */
function resolveVersion(pkg: PackageJson, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
}

/**
 * Compare the resolved version string of each CDK_Dependencies entry in the
 * Control_Plane_App `package.json` against the corresponding entry in the
 * App_Plane_App `package.json` (Req 2.3).
 *
 * - matched: present in both apps with identical version strings.
 * - divergent: present in both apps but with differing version strings (Req 2.4).
 * - missing: present in exactly one app, absent from the other (Req 2.5).
 *
 * `isFailure` is true when any divergent or missing entry exists; while true, the
 * caller must retain the pre-upgrade versions of both apps (Req 2.6).
 */
export function compare(controlPlane: PackageJson, appPlane: PackageJson): LockstepReport {
  const matched: string[] = [];
  const divergent: { name: string; controlPlane: string; appPlane: string }[] = [];
  const missing: { name: string; absentIn: 'control-plane' | 'app-plane' }[] = [];

  for (const name of CDK_DEPENDENCIES) {
    const cp = resolveVersion(controlPlane, name);
    const ap = resolveVersion(appPlane, name);

    if (cp === undefined && ap === undefined) {
      // Absent from both apps: not a CDK_Dependencies entry in either set, so it is
      // neither divergent nor missing (Req 2.5 concerns entries present in one only).
      continue;
    }

    if (cp === undefined) {
      missing.push({ name, absentIn: 'control-plane' });
      continue;
    }
    if (ap === undefined) {
      missing.push({ name, absentIn: 'app-plane' });
      continue;
    }

    if (cp === ap) {
      matched.push(name);
    } else {
      divergent.push({ name, controlPlane: cp, appPlane: ap });
    }
  }

  return {
    matched,
    divergent,
    missing,
    isFailure: divergent.length > 0 || missing.length > 0,
  };
}

/**
 * Read and parse a `package.json` from disk.
 */
export function readPackageJson(path: string): PackageJson {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as PackageJson;
}

/**
 * Run the cross-app lockstep comparison directly against the two real app
 * `package.json` files on disk (CC1 verification). Returns the {@link LockstepReport}.
 */
export function compareAppPackageFiles(
  controlPlanePath: string,
  appPlanePath: string
): LockstepReport {
  const controlPlane = readPackageJson(controlPlanePath);
  const appPlane = readPackageJson(appPlanePath);
  return compare(controlPlane, appPlane);
}

/** Human-readable label for an app id, used in failure reports. */
export function appLabel(app: AppId): string {
  return app === 'control-plane' ? 'Control_Plane_App' : 'App_Plane_App';
}
