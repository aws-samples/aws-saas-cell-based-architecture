/**
 * Engines / Workshop-Prerequisite Consistency Checker (Design Component: Language/
 * tooling baseline, CC2).
 *
 * Verifies that the Node.js version range declared in a `package.json` `engines`
 * field is consistent with the Node.js version stated in the Workshop_Content
 * prerequisites (`p`). The check passes for a `package.json` iff:
 *
 *   1. the minimum of the declared `engines` range equals `p`  (Req 3.2), AND
 *   2. `p` falls within the declared `engines` range `[min, max)` (Req 3.3).
 *
 * Otherwise the offending `package.json` is reported with an error indication
 * identifying the file (Req 3.3).
 *
 * The engines field `"node": ">=22.0.0 <25.0.0"` is declared in both app
 * `package.json` files; the Workshop Node prerequisite `p` is `22` (the lower bound
 * of the engines range, per the design Target Version Matrix).
 *
 * Interface (design): `checkEnginesConsistency(entries, p) -> EnginesConsistencyReport`.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import type { PackageJson } from './models';

/**
 * The Node.js version stated in the Workshop_Content prerequisites. Equal to the
 * lower bound of the declared `engines` range (design Target Version Matrix: "Lower
 * bound 22 equals the workshop prerequisite (Req 3.2)").
 */
export const WORKSHOP_NODE_PREREQUISITE = '22';

/** A parsed semantic version triple. */
interface Ver {
  major: number;
  minor: number;
  patch: number;
}

/** A single parsed comparator from an `engines` range, e.g. `>=22.0.0`. */
interface Comparator {
  op: '>=' | '>' | '<=' | '<' | '=';
  version: Ver;
}

/** One package.json's consistency outcome. */
export interface EnginesConsistencyResult {
  /** identifier of the package.json under test (path or label) */
  packageJson: string;
  /** the raw `engines.node` range, or undefined when absent */
  nodeEngines?: string;
  /** the workshop prerequisite `p` as supplied */
  workshopPrerequisite: string;
  /** the lower bound of the range as `major.minor.patch`, or null when unparseable */
  minVersion: string | null;
  /** the upper bound of the range as `major.minor.patch`, or null when none/unparseable */
  maxVersion: string | null;
  /** Req 3.2: the range minimum equals `p` */
  minEqualsPrerequisite: boolean;
  /** Req 3.3: `p` falls within the declared range */
  prerequisiteWithinRange: boolean;
  /** true iff both conditions hold */
  consistent: boolean;
  /** human-readable error indications when inconsistent (empty when consistent) */
  errors: string[];
}

/** Aggregate consistency report over one or more package.json files. */
export interface EnginesConsistencyReport {
  results: EnginesConsistencyResult[];
  /** identifiers of every package.json found inconsistent (Req 3.3) */
  offending: string[];
  /** true when any package.json is inconsistent */
  isFailure: boolean;
}

/** A package.json paired with the identifier used to report it. */
export interface EnginesEntry {
  packageJson: string;
  pkg: PackageJson;
}

const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const COMPARATOR_RE = /^(>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * Coerce a version-like string (`"22"`, `"22.0"`, `"22.0.0"`) into a full
 * {@link Ver}. Missing minor/patch components default to 0. Returns null when the
 * input is not a recognizable numeric version.
 */
function coerceVersion(input: string): Ver | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] !== undefined ? Number(m[2]) : 0,
    patch: m[3] !== undefined ? Number(m[3]) : 0,
  };
}

/** Compare two versions: -1 (a<b), 0 (a==b), 1 (a>b). */
function cmp(a: Ver, b: Ver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

const fmt = (v: Ver): string => `${v.major}.${v.minor}.${v.patch}`;

/**
 * Parse a Node `engines` range string (e.g. `>=22.0.0 <25.0.0`) into its
 * comparators. Returns null when any token is not a valid comparator.
 */
function parseRange(range: string): Comparator[] | null {
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const m = COMPARATOR_RE.exec(token);
    if (!m) return null;
    const op = (m[1] ?? '=') as Comparator['op'];
    comparators.push({
      op,
      version: {
        major: Number(m[2]),
        minor: m[3] !== undefined ? Number(m[3]) : 0,
        patch: m[4] !== undefined ? Number(m[4]) : 0,
      },
    });
  }
  return comparators;
}

/** Does version `p` satisfy a single comparator? */
function satisfiesComparator(p: Ver, c: Comparator): boolean {
  const r = cmp(p, c.version);
  switch (c.op) {
    case '>=':
      return r >= 0;
    case '>':
      return r > 0;
    case '<=':
      return r <= 0;
    case '<':
      return r < 0;
    case '=':
      return r === 0;
  }
}

/** The lower-bound comparator (`>=` or `>`) of a range, if any. */
function lowerBound(comparators: Comparator[]): Comparator | undefined {
  return comparators.find((c) => c.op === '>=' || c.op === '>');
}

/** The upper-bound comparator (`<` or `<=`) of a range, if any. */
function upperBound(comparators: Comparator[]): Comparator | undefined {
  return comparators.find((c) => c.op === '<' || c.op === '<=');
}

/**
 * Check a single `package.json`'s `engines.node` range against the workshop
 * prerequisite `p`. Passes iff `min == p` AND `p` is within the declared range.
 */
export function checkEntry(entry: EnginesEntry, workshopPrerequisite: string): EnginesConsistencyResult {
  const { packageJson, pkg } = entry;
  const nodeEngines = pkg.engines?.node;
  const errors: string[] = [];

  const pVer = coerceVersion(workshopPrerequisite);
  if (pVer === null) {
    errors.push(
      `Workshop Node prerequisite "${workshopPrerequisite}" is not a valid version.`
    );
  }

  if (nodeEngines === undefined) {
    errors.push(`${packageJson}: no engines.node range is declared.`);
    return {
      packageJson,
      nodeEngines,
      workshopPrerequisite,
      minVersion: null,
      maxVersion: null,
      minEqualsPrerequisite: false,
      prerequisiteWithinRange: false,
      consistent: false,
      errors,
    };
  }

  const comparators = parseRange(nodeEngines);
  if (comparators === null) {
    errors.push(`${packageJson}: engines.node range "${nodeEngines}" is not parseable.`);
    return {
      packageJson,
      nodeEngines,
      workshopPrerequisite,
      minVersion: null,
      maxVersion: null,
      minEqualsPrerequisite: false,
      prerequisiteWithinRange: false,
      consistent: false,
      errors,
    };
  }

  const lo = lowerBound(comparators);
  const hi = upperBound(comparators);
  const minVersion = lo ? fmt(lo.version) : null;
  const maxVersion = hi ? fmt(hi.version) : null;

  let minEqualsPrerequisite = false;
  let prerequisiteWithinRange = false;

  if (pVer !== null) {
    // Req 3.2: the range minimum must equal the workshop prerequisite.
    minEqualsPrerequisite = lo !== undefined && cmp(lo.version, pVer) === 0;
    // Req 3.3: the prerequisite must fall within the declared range.
    prerequisiteWithinRange = comparators.every((c) => satisfiesComparator(pVer, c));

    if (!minEqualsPrerequisite) {
      errors.push(
        `${packageJson}: engines.node minimum (${minVersion ?? 'none'}) does not equal ` +
          `the Workshop Node prerequisite (${fmt(pVer)}) (Req 3.2).`
      );
    }
    if (!prerequisiteWithinRange) {
      errors.push(
        `${packageJson}: Workshop Node prerequisite (${fmt(pVer)}) falls outside the ` +
          `declared engines.node range "${nodeEngines}" (Req 3.3).`
      );
    }
  }

  const consistent = minEqualsPrerequisite && prerequisiteWithinRange;

  return {
    packageJson,
    nodeEngines,
    workshopPrerequisite,
    minVersion,
    maxVersion,
    minEqualsPrerequisite,
    prerequisiteWithinRange,
    consistent,
    errors,
  };
}

/**
 * Check engines / workshop-prerequisite consistency across one or more
 * `package.json` files. Reports each offending file (Req 3.3).
 */
export function checkEnginesConsistency(
  entries: EnginesEntry[],
  workshopPrerequisite: string = WORKSHOP_NODE_PREREQUISITE
): EnginesConsistencyReport {
  const results = entries.map((e) => checkEntry(e, workshopPrerequisite));
  const offending = results.filter((r) => !r.consistent).map((r) => r.packageJson);
  return {
    results,
    offending,
    isFailure: offending.length > 0,
  };
}

/** Read and parse a `package.json` from disk. */
function readPackageJsonFile(path: string): PackageJson {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as PackageJson;
}

/**
 * Run the engines consistency check directly against `package.json` files on disk.
 */
export function checkEnginesConsistencyForFiles(
  paths: string[],
  workshopPrerequisite: string = WORKSHOP_NODE_PREREQUISITE
): EnginesConsistencyReport {
  const entries: EnginesEntry[] = paths.map((p) => ({
    packageJson: p,
    pkg: readPackageJsonFile(p),
  }));
  return checkEnginesConsistency(entries, workshopPrerequisite);
}
