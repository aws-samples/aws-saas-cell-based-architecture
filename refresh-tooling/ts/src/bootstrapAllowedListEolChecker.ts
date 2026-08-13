/**
 * Bootstrap Allowed-List EOL Checker (Design Component for CC13 — Bootstrap
 * template currency; Target Version Matrix bootstrap rows).
 *
 * Verifies that the post-update SSM-document allowed-version lists in the
 * workshop bootstrap template `static/cfn/vscode-server.yaml` contain no
 * end-of-life (EOL) major version and that each default value is valid:
 *
 *   - `NodeVersion` (Req 17.4):
 *       * the allowed-values list contains NO Node.js major that is EOL
 *         (e.g. excludes `18` and `20`; target allowed `['24','22']`), AND
 *       * the default lies WITHIN the declared `engines` Node range
 *         (`>=22.0.0 <25.0.0`), inclusive of the satisfied bounds.
 *   - `DotNetVersion` (Req 17.5):
 *       * the allowed-values list contains NO .NET major that is EOL
 *         (e.g. excludes `7.0`; target allowed `['10.0','8.0']`), AND
 *       * the default equals the latest stable .NET LTS (`10.0`).
 *
 * The core {@link checkNodeAllowedList}, {@link checkDotNetAllowedList}, and
 * {@link checkBootstrapAllowedLists} are PURE functions over their inputs
 * (allowed lists, defaults, the declared engines range, the set of EOL majors,
 * and the latest .NET LTS) so they are unit- and property-testable without
 * touching the filesystem (the property test is task 17.5, Property 13).
 *
 * They return a structured pass/fail report that identifies any EOL major
 * present in an allowed list and any out-of-range / non-LTS default.
 *
 * This checker complements the bootstrap inventory builder (task 17.1,
 * `bootstrapInventoryBuilder.ts`): {@link inventoryToAllowedListInputs} bridges
 * the inventory's normalized `NodeVersion`/`DotNetVersion` rows into the inputs
 * accepted here, so the check can run directly against a built inventory.
 *
 * Feature: codebase-modernization-refresh
 */
import type { BootstrapElement } from './models';

// ---------------------------------------------------------------------------
// Canonical values from the design Target Version Matrix (bootstrap rows)
// ---------------------------------------------------------------------------

/** Declared Node `engines` range the `NodeVersion` default must fall within (Req 17.4). */
export const DECLARED_NODE_ENGINES_RANGE = '>=22.0.0 <25.0.0';

/**
 * Node.js majors that are end-of-life at the time of the refresh and therefore
 * MUST NOT appear in the `NodeVersion` allowed list (Req 17.4). Node 18 is EOL;
 * Node 20 reaches EOL ~Apr 2026.
 */
export const EOL_NODE_MAJORS: readonly string[] = ['18', '20'];

/**
 * .NET versions that are end-of-life and MUST NOT appear in the `DotNetVersion`
 * allowed list (Req 17.5). .NET 7.0 is EOL.
 */
export const EOL_DOTNET_VERSIONS: readonly string[] = ['7.0'];

/** Latest stable .NET LTS the `DotNetVersion` default must equal (Req 17.5). */
export const LATEST_DOTNET_LTS = '10.0';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Post-update `NodeVersion` parameter inputs (Req 17.4). */
export interface NodeAllowedListInput {
  /** the post-update allowed-values list, e.g. `['24','22']` */
  allowed: string[];
  /** the post-update default, e.g. `'22'` */
  default: string;
  /** the declared `engines` Node range the default must fall within */
  enginesRange: string;
  /** the set of Node majors considered end-of-life */
  eolMajors: readonly string[];
}

/** Post-update `DotNetVersion` parameter inputs (Req 17.5). */
export interface DotNetAllowedListInput {
  /** the post-update allowed-values list, e.g. `['10.0','8.0']` */
  allowed: string[];
  /** the post-update default, e.g. `'10.0'` */
  default: string;
  /** the latest stable .NET LTS the default must equal */
  latestLts: string;
  /** the set of .NET versions considered end-of-life */
  eolVersions: readonly string[];
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/** Which bootstrap allowed list a result/finding pertains to. */
export type AllowedListName = 'NodeVersion' | 'DotNetVersion';

/** Kind of problem detected. */
export type AllowedListFindingKind =
  | 'eol-major-present'
  | 'out-of-range-default'
  | 'default-not-latest-lts'
  | 'invalid-version';

/** A single structured finding. */
export interface AllowedListEolFinding {
  list: AllowedListName;
  kind: AllowedListFindingKind;
  /** human-readable error indication */
  detail: string;
  /** the offending value, when applicable */
  value?: string;
  /** the requirement clause that mandates the check */
  requirement: '17.4' | '17.5';
}

/** Per-list check outcome. */
export interface AllowedListCheckResult {
  list: AllowedListName;
  allowed: string[];
  default: string;
  /** allowed entries whose major matched an EOL major (empty when clean) */
  eolMajorsPresent: string[];
  /** Node: default within engines range; .NET: default equals latest LTS */
  defaultValid: boolean;
  /** true iff no EOL major present AND the default is valid */
  pass: boolean;
  findings: AllowedListEolFinding[];
  requirement: '17.4' | '17.5';
}

/** Aggregate report across both bootstrap allowed lists. */
export interface BootstrapAllowedListEolReport {
  node: AllowedListCheckResult;
  dotnet: AllowedListCheckResult;
  /** every finding from both lists */
  findings: AllowedListEolFinding[];
  /** true iff both lists pass */
  pass: boolean;
}

// ---------------------------------------------------------------------------
// Version parsing helpers (pure, self-contained)
// ---------------------------------------------------------------------------

interface Ver {
  major: number;
  minor: number;
  patch: number;
}

interface Comparator {
  op: '>=' | '>' | '<=' | '<' | '=';
  version: Ver;
}

const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const COMPARATOR_RE = /^(>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/** Coerce a version-like string (`"22"`, `"10.0"`, `"22.0.0"`) into a full {@link Ver}. */
function coerceVersion(input: string): Ver | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: m[2] !== undefined ? Number(m[2]) : 0,
    patch: m[3] !== undefined ? Number(m[3]) : 0,
  };
}

/** The leading major integer of a version-like string, or null when unparseable. */
function majorOf(input: string): number | null {
  const m = /^\s*(\d+)/.exec(input);
  return m ? Number(m[1]) : null;
}

/** Compare two versions: -1 (a<b), 0 (a==b), 1 (a>b). */
function cmp(a: Ver, b: Ver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** Parse a Node `engines` range string into comparators; null when any token is invalid. */
function parseRange(range: string): Comparator[] | null {
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const m = COMPARATOR_RE.exec(token);
    if (!m) {
      return null;
    }
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

// ---------------------------------------------------------------------------
// EOL detection
// ---------------------------------------------------------------------------

/**
 * Return the allowed entries whose major version matches an EOL major. Matching
 * is by major integer (e.g. allowed `'8.0'` has major `8`; EOL `'7.0'` has major
 * `7`), so it is robust to `'20'` vs `'20.x'` and `'7.0'` vs `'7'` forms.
 */
export function findEolMajorsPresent(
  allowed: string[],
  eolMajors: readonly string[]
): string[] {
  const eolSet = new Set<number>();
  for (const e of eolMajors) {
    const m = majorOf(e);
    if (m !== null) {
      eolSet.add(m);
    }
  }
  return allowed.filter((a) => {
    const m = majorOf(a);
    return m !== null && eolSet.has(m);
  });
}

// ---------------------------------------------------------------------------
// Per-list checkers (pure)
// ---------------------------------------------------------------------------

/**
 * Check the `NodeVersion` allowed list and default (Req 17.4):
 *   - no EOL major present in the allowed list, AND
 *   - the default falls within the declared `engines` range.
 */
export function checkNodeAllowedList(input: NodeAllowedListInput): AllowedListCheckResult {
  const findings: AllowedListEolFinding[] = [];

  const eolMajorsPresent = findEolMajorsPresent(input.allowed, input.eolMajors);
  for (const value of eolMajorsPresent) {
    findings.push({
      list: 'NodeVersion',
      kind: 'eol-major-present',
      detail: `NodeVersion allowed list contains end-of-life Node major "${value}" (Req 17.4).`,
      value,
      requirement: '17.4',
    });
  }

  let defaultValid = false;
  const defaultVer = coerceVersion(input.default);
  const comparators = parseRange(input.enginesRange);
  if (defaultVer === null) {
    findings.push({
      list: 'NodeVersion',
      kind: 'invalid-version',
      detail: `NodeVersion default "${input.default}" is not a valid version (Req 17.4).`,
      value: input.default,
      requirement: '17.4',
    });
  } else if (comparators === null) {
    findings.push({
      list: 'NodeVersion',
      kind: 'invalid-version',
      detail: `Declared engines range "${input.enginesRange}" is not parseable (Req 17.4).`,
      value: input.enginesRange,
      requirement: '17.4',
    });
  } else {
    defaultValid = comparators.every((c) => satisfiesComparator(defaultVer, c));
    if (!defaultValid) {
      findings.push({
        list: 'NodeVersion',
        kind: 'out-of-range-default',
        detail:
          `NodeVersion default "${input.default}" falls outside the declared engines ` +
          `range "${input.enginesRange}" (Req 17.4).`,
        value: input.default,
        requirement: '17.4',
      });
    }
  }

  return {
    list: 'NodeVersion',
    allowed: input.allowed,
    default: input.default,
    eolMajorsPresent,
    defaultValid,
    pass: eolMajorsPresent.length === 0 && defaultValid,
    findings,
    requirement: '17.4',
  };
}

/**
 * Check the `DotNetVersion` allowed list and default (Req 17.5):
 *   - no EOL version present in the allowed list, AND
 *   - the default equals the latest stable .NET LTS.
 */
export function checkDotNetAllowedList(input: DotNetAllowedListInput): AllowedListCheckResult {
  const findings: AllowedListEolFinding[] = [];

  const eolMajorsPresent = findEolMajorsPresent(input.allowed, input.eolVersions);
  for (const value of eolMajorsPresent) {
    findings.push({
      list: 'DotNetVersion',
      kind: 'eol-major-present',
      detail: `DotNetVersion allowed list contains end-of-life .NET version "${value}" (Req 17.5).`,
      value,
      requirement: '17.5',
    });
  }

  const defaultValid = input.default.trim() === input.latestLts.trim();
  if (!defaultValid) {
    findings.push({
      list: 'DotNetVersion',
      kind: 'default-not-latest-lts',
      detail:
        `DotNetVersion default "${input.default}" does not equal the latest .NET LTS ` +
        `"${input.latestLts}" (Req 17.5).`,
      value: input.default,
      requirement: '17.5',
    });
  }

  return {
    list: 'DotNetVersion',
    allowed: input.allowed,
    default: input.default,
    eolMajorsPresent,
    defaultValid,
    pass: eolMajorsPresent.length === 0 && defaultValid,
    findings,
    requirement: '17.5',
  };
}

/**
 * Aggregate checker over both bootstrap allowed lists. The report passes iff both
 * the `NodeVersion` (Req 17.4) and `DotNetVersion` (Req 17.5) checks pass.
 */
export function checkBootstrapAllowedLists(
  node: NodeAllowedListInput,
  dotnet: DotNetAllowedListInput
): BootstrapAllowedListEolReport {
  const nodeResult = checkNodeAllowedList(node);
  const dotnetResult = checkDotNetAllowedList(dotnet);
  return {
    node: nodeResult,
    dotnet: dotnetResult,
    findings: [...nodeResult.findings, ...dotnetResult.findings],
    pass: nodeResult.pass && dotnetResult.pass,
  };
}

// ---------------------------------------------------------------------------
// Inventory bridge (complements task 17.1)
// ---------------------------------------------------------------------------

/** Parse a normalized list string (`["24","22"]`) or a fallback raw form to entries. */
function parseNormalizedList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x));
    }
  } catch {
    // fall through to permissive parsing below
  }
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
}

/** Find the post-update value of a bootstrap element by the tail of its location. */
function findValue(elements: BootstrapElement[], locationSuffix: string): string | undefined {
  const el = elements.find((e) => e.location.endsWith(locationSuffix));
  return el?.targetValue;
}

/**
 * Bridge a built bootstrap inventory (task 17.1) into the checker inputs, reading
 * the post-update (`targetValue`) `NodeVersion`/`DotNetVersion` default and
 * allowed rows. Throws when a required row is absent from the inventory.
 */
export function inventoryToAllowedListInputs(
  elements: BootstrapElement[],
  options?: {
    enginesRange?: string;
    eolNodeMajors?: readonly string[];
    eolDotNetVersions?: readonly string[];
    latestDotNetLts?: string;
  }
): { node: NodeAllowedListInput; dotnet: DotNetAllowedListInput } {
  const nodeDefault = findValue(elements, 'NodeVersion.default');
  const nodeAllowed = findValue(elements, 'NodeVersion.allowedValues');
  const dotnetDefault = findValue(elements, 'DotNetVersion.default');
  const dotnetAllowed = findValue(elements, 'DotNetVersion.allowedValues');

  if (
    nodeDefault === undefined ||
    nodeAllowed === undefined ||
    dotnetDefault === undefined ||
    dotnetAllowed === undefined
  ) {
    throw new Error(
      'Bootstrap inventory is missing one or more NodeVersion/DotNetVersion rows required for the EOL check.'
    );
  }

  return {
    node: {
      allowed: parseNormalizedList(nodeAllowed),
      default: nodeDefault,
      enginesRange: options?.enginesRange ?? DECLARED_NODE_ENGINES_RANGE,
      eolMajors: options?.eolNodeMajors ?? EOL_NODE_MAJORS,
    },
    dotnet: {
      allowed: parseNormalizedList(dotnetAllowed),
      default: dotnetDefault,
      latestLts: options?.latestDotNetLts ?? LATEST_DOTNET_LTS,
      eolVersions: options?.eolDotNetVersions ?? EOL_DOTNET_VERSIONS,
    },
  };
}

/**
 * Run the bootstrap allowed-list EOL check directly against a built inventory
 * (task 17.1 output) using the canonical design defaults unless overridden.
 */
export function checkBootstrapAllowedListsFromInventory(
  elements: BootstrapElement[],
  options?: Parameters<typeof inventoryToAllowedListInputs>[1]
): BootstrapAllowedListEolReport {
  const { node, dotnet } = inventoryToAllowedListInputs(elements, options);
  return checkBootstrapAllowedLists(node, dotnet);
}
