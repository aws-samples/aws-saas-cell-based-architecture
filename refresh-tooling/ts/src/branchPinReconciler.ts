/**
 * Branch-Pin / Version Reconciler (Design Component 9 sub-component, CC11).
 *
 * Reads the workshop branch pin (`RepoBranchName` in `static/cfn/WorkshopStack.yaml`)
 * and the root repository `package.json` version, then resolves the target release
 * tag as the HIGHER of the two by semantic-version precedence (major, then minor,
 * then patch). The actual application of the resolved tag to the branch pin and the
 * two `package.json` versions is performed by task 15.2; this component only reads
 * and resolves, so {@link BranchPinReconciliation.applied} is always `false` here.
 *
 * Behavior (Requirements 13.1, 13.5):
 *   - 13.1: read the current Branch_Pin value from `WorkshopStack.yaml` and the
 *     repository `package.json` version, resolve the target tag as the higher of
 *     the two semantic versions (per semantic-version precedence), and record the
 *     resolved target tag.
 *   - 13.5: IF the Branch_Pin value and the repository `package.json` version are
 *     not valid semantic versions or cannot be ordered into a single resolved
 *     target tag, THEN halt the reconciliation, leave the Branch_Pin and both
 *     `package.json` versions unchanged, and record an entry indicating the
 *     conflicting Branch_Pin value and repository version. Here the halt surfaces
 *     as a populated `error` with an empty `resolvedTag` and `applied === false`;
 *     because nothing is written, both versions and the pin remain unchanged.
 *
 * The semver parse/compare/resolve logic is implemented as PURE functions
 * ({@link parseSemver}, {@link compareSemver}, {@link resolveHigherTag}) so it is
 * property-testable without touching the filesystem (the property test is task 15.3,
 * the `v1.3.1` vs `1.2.1` -> `1.3.1` unit example is task 15.4).
 *
 * Interface (design): `reconcileVersions()`.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BranchPinReconciliation } from './models';

/** A parsed semantic version (build metadata is parsed but ignored in precedence). */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** dot-separated prerelease identifiers, empty when this is a release version */
  prerelease: string[];
  /** dot-separated build-metadata identifiers (ignored for precedence) */
  build: string[];
}

/**
 * Parse a semantic version string, tolerating a single optional leading `v`
 * (so both `v1.3.1` and `1.3.1` are accepted). Returns `null` when the input is
 * not a valid `major.minor.patch[-prerelease][+build]` semantic version.
 *
 * This is a pure function (Req 13.1 / Property 10).
 */
export function parseSemver(raw: string): SemVer | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  // Optional single leading `v`/`V`, then strict semver core + optional pre/build.
  const re =
    /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  const m = re.exec(trimmed);
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
  };
}

/** True iff the identifier is composed solely of digits (a numeric identifier). */
function isNumeric(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * Compare two prerelease identifier lists per the semantic-versioning spec (§11.4).
 * A release version (empty prerelease) has HIGHER precedence than a prerelease.
 * Returns -1, 0, or 1.
 */
function comparePrerelease(a: string[], b: string[]): number {
  const aHas = a.length > 0;
  const bHas = b.length > 0;
  if (!aHas && !bHas) return 0;
  // A version without a prerelease outranks one with a prerelease.
  if (!aHas) return 1;
  if (!bHas) return -1;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const aNum = isNumeric(ai);
    const bNum = isNumeric(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return aNum ? -1 : 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  // All shared identifiers equal: the longer set has higher precedence.
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Compare two parsed semantic versions by precedence (major, then minor, then
 * patch, then prerelease). Build metadata is ignored. Returns -1 when `a < b`,
 * 0 when equal in precedence, 1 when `a > b`.
 *
 * This is a pure function (Req 13.1 / Property 10).
 */
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Reconstruct the canonical (no leading `v`) tag string for a parsed version. */
export function formatTag(v: SemVer): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length > 0 ? `${core}-${v.prerelease.join('.')}` : core;
}

/** Outcome of resolving a single target tag from two version strings. */
export interface ResolveResult {
  /** the higher version as a canonical tag (no leading `v`); empty on halt */
  resolvedTag: string;
  /** populated when resolution halts per Req 13.5 */
  error?: string;
}

/**
 * Resolve the target tag as the HIGHER of the two given version strings by
 * semantic-version precedence. When the two are equal in precedence, the shared
 * version is returned. When either string is not a valid semantic version (and so
 * the pair cannot be ordered into a single resolved tag), resolution HALTS and an
 * error describing the conflict is returned with an empty `resolvedTag` (Req 13.5).
 *
 * Resolution is commutative and idempotent over valid inputs (Property 10).
 * This is a pure function.
 */
export function resolveHigherTag(pinValue: string, repoVersion: string): ResolveResult {
  const pin = parseSemver(pinValue);
  const repo = parseSemver(repoVersion);

  if (pin === null || repo === null) {
    const offenders: string[] = [];
    if (pin === null) offenders.push(`Branch_Pin "${pinValue}"`);
    if (repo === null) offenders.push(`repository package.json version "${repoVersion}"`);
    return {
      resolvedTag: '',
      error:
        `Cannot resolve a target tag: ${offenders.join(' and ')} ` +
        `${offenders.length > 1 ? 'are' : 'is'} not a valid semantic version. ` +
        `Reconciliation halted; Branch_Pin and both package.json versions left ` +
        `unchanged for maintainer resolution (Req 13.5).`,
    };
  }

  const higher = compareSemver(pin, repo) >= 0 ? pin : repo;
  return { resolvedTag: formatTag(higher) };
}

/** Repository-relative path to the root `package.json`. */
export const ROOT_PACKAGE_JSON_RELATIVE_PATH = 'package.json';

/**
 * Workshop-relative path (within the workshop repository) to the bootstrap
 * CloudFormation template that declares the `RepoBranchName` branch pin.
 */
export const WORKSHOP_STACK_RELATIVE_PATH = 'static/cfn/WorkshopStack.yaml';

/**
 * Default absolute path to the workshop repository. The workshop is a sibling of
 * the code repository; the reconciler reads the post-refresh repository values and
 * the workshop branch pin from their respective trees.
 */
export const DEFAULT_WORKSHOP_REPO_ROOT = path.resolve(
  __dirname,
  '../../../../building-resilient-and-scalable-saas-applications-with-a-cell-based-architecture'
);

/**
 * Read the `RepoBranchName` parameter default from a `WorkshopStack.yaml` body.
 * Returns `null` when the parameter or its `Default` cannot be located, so the
 * caller can record the halt condition rather than guessing a value.
 *
 * The lookup is scoped to the `RepoBranchName:` parameter block and reads the first
 * `Default:` entry beneath it, tolerating quoted or unquoted scalar values.
 */
export function extractRepoBranchName(yamlBody: string): string | null {
  const lines = yamlBody.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*RepoBranchName\s*:/.test(lines[i])) {
      // Scan the parameter's nested block for the first `Default:` key.
      for (let j = i + 1; j < lines.length; j++) {
        // Stop at the next top-level (2-space) parameter key.
        if (/^\s{0,2}\S.*:/.test(lines[j]) && !/^\s{4,}/.test(lines[j])) {
          // Only break if this line is a sibling parameter (not deeper-indented).
          const indent = lines[j].match(/^\s*/)?.[0].length ?? 0;
          if (indent <= 2 && !/^\s*Default\s*:/.test(lines[j])) break;
        }
        const dm = /^\s*Default\s*:\s*(.+?)\s*$/.exec(lines[j]);
        if (dm) {
          return dm[1].replace(/^["']|["']$/g, '').trim();
        }
      }
      return null;
    }
  }
  return null;
}

/** Inputs to {@link reconcileVersions}; all optional with filesystem-backed defaults. */
export interface ReconcileInput {
  /** Explicit branch-pin value; when omitted it is read from `WorkshopStack.yaml`. */
  currentPin?: string;
  /** Explicit repo version; when omitted it is read from the root `package.json`. */
  repoVersion?: string;
  /** Code repository root (defaults to the resolved package root). */
  repoRoot?: string;
  /** Workshop repository root (defaults to {@link DEFAULT_WORKSHOP_REPO_ROOT}). */
  workshopRepoRoot?: string;
}

/**
 * Reconcile the workshop branch pin with the repository version (read + resolve).
 *
 * Reads the `RepoBranchName` value from the workshop `WorkshopStack.yaml` and the
 * root `package.json` version (unless supplied explicitly), then resolves the
 * higher of the two by semver precedence (Req 13.1). On any invalid/unorderable
 * value it halts: `resolvedTag` is empty, `error` describes the conflict, and
 * `applied` is `false`, so the pin and both versions are left unchanged (Req 13.5).
 *
 * `applied` is always `false` here — applying the resolved tag to the pin and the
 * two `package.json` versions is task 15.2.
 */
export function reconcileVersions(input: ReconcileInput = {}): BranchPinReconciliation {
  const repoRoot = input.repoRoot ?? path.resolve(__dirname, '../../..');
  const workshopRepoRoot = input.workshopRepoRoot ?? DEFAULT_WORKSHOP_REPO_ROOT;

  let currentPin = input.currentPin;
  let repoVersion = input.repoVersion;
  const readErrors: string[] = [];

  if (currentPin === undefined) {
    const read = readRepoBranchName(workshopRepoRoot);
    if (read === null) {
      readErrors.push(
        `unable to read RepoBranchName Default from ${WORKSHOP_STACK_RELATIVE_PATH}`
      );
      currentPin = '';
    } else {
      currentPin = read;
    }
  }

  if (repoVersion === undefined) {
    const read = readRootPackageVersion(repoRoot);
    if (read === null) {
      readErrors.push(
        `unable to read version from ${ROOT_PACKAGE_JSON_RELATIVE_PATH}`
      );
      repoVersion = '';
    } else {
      repoVersion = read;
    }
  }

  // A read failure is itself a halt condition: leave everything unchanged (Req 13.5).
  if (readErrors.length > 0) {
    return {
      currentPin,
      repoVersion,
      resolvedTag: '',
      applied: false,
      error:
        `Reconciliation halted before resolution: ${readErrors.join('; ')}. ` +
        `Branch_Pin and both package.json versions left unchanged (Req 13.5).`,
    };
  }

  const { resolvedTag, error } = resolveHigherTag(currentPin, repoVersion);

  return {
    currentPin,
    repoVersion,
    resolvedTag,
    applied: false,
    ...(error ? { error } : {}),
  };
}

/**
 * Read the `RepoBranchName` Default from the workshop `WorkshopStack.yaml`. Returns
 * `null` when the file cannot be read or the parameter/default is absent, so the
 * caller can record the halt condition. Mirrors the fallible-loader pattern used by
 * the other refresh components.
 */
export function readRepoBranchName(
  workshopRepoRoot = DEFAULT_WORKSHOP_REPO_ROOT,
  relativePath = WORKSHOP_STACK_RELATIVE_PATH
): string | null {
  try {
    const body = fs.readFileSync(path.resolve(workshopRepoRoot, relativePath), 'utf8');
    return extractRepoBranchName(body);
  } catch {
    return null;
  }
}

/**
 * Read the `version` field from the root repository `package.json`. Returns `null`
 * when the file cannot be read/parsed or the field is absent.
 */
export function readRootPackageVersion(
  repoRoot = path.resolve(__dirname, '../../..'),
  relativePath = ROOT_PACKAGE_JSON_RELATIVE_PATH
): string | null {
  try {
    const body = fs.readFileSync(path.resolve(repoRoot, relativePath), 'utf8');
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}
