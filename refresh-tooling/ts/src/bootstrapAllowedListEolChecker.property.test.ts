/**
 * Property-based tests for the Bootstrap Allowed-List EOL Checker (CC13 —
 * Bootstrap template currency).
 *
 * Feature: codebase-modernization-refresh, Property 13
 *
 * Property 13: Bootstrap allowed-version lists exclude end-of-life majors
 * Validates: Requirements 17.4, 17.5
 *
 * Over arbitrary allowed-version lists and defaults:
 *   - the NodeVersion check (Req 17.4) passes IFF no allowed entry shares a
 *     major with an EOL Node major AND the default lies within the declared
 *     engines range `>=22.0.0 <25.0.0` (lower bound inclusive, upper exclusive);
 *   - the DotNetVersion check (Req 17.5) passes IFF no allowed entry shares a
 *     major with an EOL .NET version AND the default equals the latest LTS;
 *   - the aggregate passes IFF both per-list checks pass.
 *
 * Each oracle below is derived directly from the requirement text, independent
 * of the checker implementation.
 */
import fc from 'fast-check';
import {
  checkNodeAllowedList,
  checkDotNetAllowedList,
  checkBootstrapAllowedLists,
  DECLARED_NODE_ENGINES_RANGE,
  EOL_NODE_MAJORS,
  EOL_DOTNET_VERSIONS,
  LATEST_DOTNET_LTS,
} from './bootstrapAllowedListEolChecker';

// ---------------------------------------------------------------------------
// Requirement-derived oracles (no dependency on the checker internals)
// ---------------------------------------------------------------------------

/** Leading major integer of a version-like string, or null when unparseable. */
function majorOf(s: string): number | null {
  const m = /^\s*(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

/** True iff any allowed entry shares a major with one of the EOL majors. */
function hasEolMajor(allowed: string[], eol: readonly string[]): boolean {
  const eolMajors = new Set(eol.map(majorOf).filter((n): n is number => n !== null));
  return allowed.some((a) => {
    const m = majorOf(a);
    return m !== null && eolMajors.has(m);
  });
}

/** Full-tuple compare of two [major,minor,patch] arrays. */
function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Oracle: does the default fall within `>=22.0.0 <25.0.0`? */
function nodeDefaultInRange(d: string): boolean {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(d.trim());
  if (!m) return false;
  const v = [Number(m[1]), m[2] !== undefined ? Number(m[2]) : 0, m[3] !== undefined ? Number(m[3]) : 0];
  return cmp(v, [22, 0, 0]) >= 0 && cmp(v, [25, 0, 0]) < 0;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// Node majors: a mix of EOL (18, 20), in-range (22, 24), and neighbours.
const nodeEntry = fc.constantFrom('18', '19', '20', '21', '22', '23', '24', '25');
const nodeAllowedArb = fc.array(nodeEntry, { minLength: 1, maxLength: 6 });
const nodeDefaultArb = fc.constantFrom('22', '24', '22.10.0', '20', '25', '18', '23', 'latest', '');

// .NET versions: EOL 7.0, LTS 10.0, plus neighbours.
const dotnetEntry = fc.constantFrom('6.0', '7.0', '8.0', '9.0', '10.0');
const dotnetAllowedArb = fc.array(dotnetEntry, { minLength: 1, maxLength: 5 });
const dotnetDefaultArb = fc.constantFrom('10.0', '8.0', '7.0', '9.0');

describe('Feature: codebase-modernization-refresh, Property 13 — Bootstrap allowed-version lists exclude end-of-life majors', () => {
  it('NodeVersion check passes IFF no EOL major present AND default in engines range (Req 17.4)', () => {
    fc.assert(
      fc.property(nodeAllowedArb, nodeDefaultArb, (allowed, def) => {
        const r = checkNodeAllowedList({
          allowed,
          default: def,
          enginesRange: DECLARED_NODE_ENGINES_RANGE,
          eolMajors: EOL_NODE_MAJORS,
        });
        const oracle = !hasEolMajor(allowed, EOL_NODE_MAJORS) && nodeDefaultInRange(def);
        expect(r.pass).toBe(oracle);
        // When any EOL major is present it MUST be reported as a finding (Req 17.4).
        if (hasEolMajor(allowed, EOL_NODE_MAJORS)) {
          expect(r.eolMajorsPresent.length).toBeGreaterThan(0);
          expect(r.findings.some((f) => f.kind === 'eol-major-present')).toBe(true);
        } else {
          expect(r.eolMajorsPresent).toEqual([]);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('DotNetVersion check passes IFF no EOL version present AND default equals latest LTS (Req 17.5)', () => {
    fc.assert(
      fc.property(dotnetAllowedArb, dotnetDefaultArb, (allowed, def) => {
        const r = checkDotNetAllowedList({
          allowed,
          default: def,
          latestLts: LATEST_DOTNET_LTS,
          eolVersions: EOL_DOTNET_VERSIONS,
        });
        const oracle = !hasEolMajor(allowed, EOL_DOTNET_VERSIONS) && def.trim() === LATEST_DOTNET_LTS;
        expect(r.pass).toBe(oracle);
        if (hasEolMajor(allowed, EOL_DOTNET_VERSIONS)) {
          expect(r.findings.some((f) => f.kind === 'eol-major-present')).toBe(true);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('aggregate passes IFF both per-list checks pass (Req 17.4, 17.5)', () => {
    fc.assert(
      fc.property(nodeAllowedArb, nodeDefaultArb, dotnetAllowedArb, dotnetDefaultArb, (na, nd, da, dd) => {
        const report = checkBootstrapAllowedLists(
          { allowed: na, default: nd, enginesRange: DECLARED_NODE_ENGINES_RANGE, eolMajors: EOL_NODE_MAJORS },
          { allowed: da, default: dd, latestLts: LATEST_DOTNET_LTS, eolVersions: EOL_DOTNET_VERSIONS }
        );
        const nodeOracle = !hasEolMajor(na, EOL_NODE_MAJORS) && nodeDefaultInRange(nd);
        const dotnetOracle = !hasEolMajor(da, EOL_DOTNET_VERSIONS) && dd.trim() === LATEST_DOTNET_LTS;
        expect(report.pass).toBe(nodeOracle && dotnetOracle);
      }),
      { numRuns: 300 }
    );
  });

  it('the applied bootstrap target lists (Node ["24","22"]/22, .NET ["10.0","8.0"]/10.0) pass', () => {
    const report = checkBootstrapAllowedLists(
      { allowed: ['24', '22'], default: '22', enginesRange: DECLARED_NODE_ENGINES_RANGE, eolMajors: EOL_NODE_MAJORS },
      { allowed: ['10.0', '8.0'], default: '10.0', latestLts: LATEST_DOTNET_LTS, eolVersions: EOL_DOTNET_VERSIONS }
    );
    expect(report.pass).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
