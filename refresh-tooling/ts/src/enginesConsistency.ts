/**
 * Engines / workshop-prerequisite consistency checker (Design Component: CC2 baseline).
 *
 * Feature: codebase-modernization-refresh
 *
 * Implements the consistency rule behind Requirements 3.2 and 3.3:
 *
 *  - Req 3.2: the MINIMUM supported Node.js version declared in a `package.json`
 *    `engines` range MUST equal the Node.js version stated in the Workshop_Content
 *    prerequisites (`p`).
 *  - Req 3.3: IF the workshop prerequisite `p` falls outside the declared `engines`
 *    range, THE checker reports the declaration as inconsistent, identifying the
 *    offending `package.json` file.
 *
 * The declared `engines` range uses the conventional npm form `">=<min>.x.y <<max>.x.y"`,
 * e.g. `">=22.0.0 <25.0.0"`, where the lower bound is INCLUSIVE and the upper bound is
 * EXCLUSIVE. The checker therefore passes iff:
 *
 *      min === p   AND   min <= p < max
 *
 * (Given `min === p` and a well-formed range `min < max`, the bounds clause holds
 *  automatically; both clauses are checked explicitly to stay faithful to the spec.)
 */

/** A parsed `engines` Node range: `min` inclusive lower bound, `max` exclusive upper bound. */
export interface EnginesRange {
  /** inclusive lower-bound major version */
  min: number;
  /** exclusive upper-bound major version */
  max: number;
}

/** Inputs to the engines / workshop-prerequisite consistency check. */
export interface EnginesConsistencyInput {
  /** raw `engines.node` string, e.g. ">=22.0.0 <25.0.0" */
  enginesRange: string;
  /** workshop Node.js prerequisite major version, e.g. 22 */
  prerequisite: number;
  /** the `package.json` path, reported when inconsistent (Req 3.3) */
  packageJsonPath: string;
}

/** Result of the consistency check. */
export interface EnginesConsistencyResult {
  /** true iff min === p and p is within [min, max) */
  consistent: boolean;
  /** the offending `package.json` (populated only when inconsistent — Req 3.3) */
  offendingFile?: string;
  /** human-readable reason for an inconsistency */
  reason?: string;
}

/**
 * Parse an npm-style `engines` Node range of the form `">=<min>.x.y <<max>.x.y"`.
 * Returns `null` when the string cannot be parsed into an ordered `[min, max)` range.
 */
export function parseEnginesRange(range: string): EnginesRange | null {
  if (typeof range !== 'string') {
    return null;
  }
  const minMatch = range.match(/>=\s*(\d+)(?:\.\d+){0,2}/);
  const maxMatch = range.match(/<\s*(\d+)(?:\.\d+){0,2}/);
  if (!minMatch || !maxMatch) {
    return null;
  }
  const min = Number(minMatch[1]);
  const max = Number(maxMatch[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }
  return { min, max };
}

/**
 * Core predicate: given a `[min, max)` major-version range and a workshop
 * prerequisite `p`, the engines declaration is consistent iff `min === p`
 * and `p` lies within the range (`min <= p < max`).
 */
export function isEnginesPrerequisiteConsistent(min: number, max: number, p: number): boolean {
  return min === p && p >= min && p < max;
}

/**
 * Check a `package.json` engines declaration against the workshop Node prerequisite.
 * On any inconsistency the offending file is reported (Req 3.3).
 */
export function checkEnginesConsistency(input: EnginesConsistencyInput): EnginesConsistencyResult {
  const range = parseEnginesRange(input.enginesRange);
  if (range === null) {
    return {
      consistent: false,
      offendingFile: input.packageJsonPath,
      reason: `Unparseable or non-ordered engines range "${input.enginesRange}"`,
    };
  }
  if (isEnginesPrerequisiteConsistent(range.min, range.max, input.prerequisite)) {
    return { consistent: true };
  }
  const detail =
    range.min !== input.prerequisite
      ? `engines minimum (${range.min}) does not equal workshop prerequisite (${input.prerequisite})`
      : `workshop prerequisite (${input.prerequisite}) is outside engines range [${range.min}, ${range.max})`;
  return {
    consistent: false,
    offendingFile: input.packageJsonPath,
    reason: detail,
  };
}
