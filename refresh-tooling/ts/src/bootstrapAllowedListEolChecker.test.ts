/**
 * Unit tests for the Bootstrap Allowed-List EOL Checker (CC13 — Bootstrap
 * template currency).
 *
 * Requirements covered: 17.4 (NodeVersion allowed list excludes EOL majors;
 * default within the engines range) and 17.5 (DotNetVersion allowed list
 * excludes EOL versions; default equals the latest LTS).
 *
 * Feature: codebase-modernization-refresh
 */
import {
  checkNodeAllowedList,
  checkDotNetAllowedList,
  checkBootstrapAllowedLists,
  checkBootstrapAllowedListsFromInventory,
  inventoryToAllowedListInputs,
  findEolMajorsPresent,
  DECLARED_NODE_ENGINES_RANGE,
  EOL_NODE_MAJORS,
  EOL_DOTNET_VERSIONS,
  LATEST_DOTNET_LTS,
  type NodeAllowedListInput,
  type DotNetAllowedListInput,
} from './bootstrapAllowedListEolChecker';
import {
  buildBootstrapInventory,
  normalizeList,
  type BootstrapTemplateContents,
} from './bootstrapInventoryBuilder';
import type { BootstrapElement } from './models';

const targetNode: NodeAllowedListInput = {
  allowed: ['24', '22'],
  default: '22',
  enginesRange: DECLARED_NODE_ENGINES_RANGE,
  eolMajors: EOL_NODE_MAJORS,
};

const targetDotNet: DotNetAllowedListInput = {
  allowed: ['10.0', '8.0'],
  default: '10.0',
  latestLts: LATEST_DOTNET_LTS,
  eolVersions: EOL_DOTNET_VERSIONS,
};

describe('checkNodeAllowedList (Req 17.4)', () => {
  it('passes for the target allowed list and in-range default', () => {
    const r = checkNodeAllowedList(targetNode);
    expect(r.pass).toBe(true);
    expect(r.eolMajorsPresent).toEqual([]);
    expect(r.defaultValid).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('flags an EOL major (20) present in the allowed list', () => {
    const r = checkNodeAllowedList({ ...targetNode, allowed: ['24', '22', '20'] });
    expect(r.pass).toBe(false);
    expect(r.eolMajorsPresent).toEqual(['20']);
    expect(r.findings.some((f) => f.kind === 'eol-major-present' && f.value === '20')).toBe(true);
  });

  it('flags both EOL majors (18 and 20) present', () => {
    const r = checkNodeAllowedList({ ...targetNode, allowed: ['22', '20', '18'] });
    expect(r.eolMajorsPresent).toEqual(['20', '18']);
    expect(r.pass).toBe(false);
  });

  it('flags a default below the engines range', () => {
    const r = checkNodeAllowedList({ ...targetNode, default: '20' });
    expect(r.defaultValid).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.kind === 'out-of-range-default')).toBe(true);
  });

  it('flags a default at/above the exclusive upper bound (25)', () => {
    const r = checkNodeAllowedList({ ...targetNode, default: '25' });
    expect(r.defaultValid).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('accepts the upper-bound-adjacent in-range default (24)', () => {
    const r = checkNodeAllowedList({ ...targetNode, default: '24' });
    expect(r.defaultValid).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('flags an unparseable default version', () => {
    const r = checkNodeAllowedList({ ...targetNode, default: 'latest' });
    expect(r.defaultValid).toBe(false);
    expect(r.findings.some((f) => f.kind === 'invalid-version')).toBe(true);
  });

  it('flags an unparseable engines range', () => {
    const r = checkNodeAllowedList({ ...targetNode, enginesRange: 'not-a-range' });
    expect(r.defaultValid).toBe(false);
    expect(r.findings.some((f) => f.kind === 'invalid-version')).toBe(true);
  });
});

describe('checkDotNetAllowedList (Req 17.5)', () => {
  it('passes for the target allowed list and LTS default', () => {
    const r = checkDotNetAllowedList(targetDotNet);
    expect(r.pass).toBe(true);
    expect(r.eolMajorsPresent).toEqual([]);
    expect(r.defaultValid).toBe(true);
  });

  it('flags the EOL version (7.0) present in the allowed list', () => {
    const r = checkDotNetAllowedList({ ...targetDotNet, allowed: ['10.0', '8.0', '7.0'] });
    expect(r.pass).toBe(false);
    expect(r.eolMajorsPresent).toEqual(['7.0']);
    expect(r.findings.some((f) => f.kind === 'eol-major-present' && f.value === '7.0')).toBe(true);
  });

  it('flags a default that is not the latest LTS', () => {
    const r = checkDotNetAllowedList({ ...targetDotNet, default: '8.0' });
    expect(r.defaultValid).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.kind === 'default-not-latest-lts')).toBe(true);
  });
});

describe('findEolMajorsPresent', () => {
  it('matches by major integer regardless of minor form', () => {
    expect(findEolMajorsPresent(['8.0', '7.0'], ['7'])).toEqual(['7.0']);
    expect(findEolMajorsPresent(['24', '22', '20'], ['18', '20'])).toEqual(['20']);
  });

  it('returns empty when no EOL majors are present', () => {
    expect(findEolMajorsPresent(['24', '22'], EOL_NODE_MAJORS)).toEqual([]);
  });
});

describe('checkBootstrapAllowedLists (aggregate)', () => {
  it('passes when both lists are clean', () => {
    const report = checkBootstrapAllowedLists(targetNode, targetDotNet);
    expect(report.pass).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('fails and aggregates findings when either list is dirty', () => {
    const report = checkBootstrapAllowedLists(
      { ...targetNode, allowed: ['24', '22', '18'] },
      { ...targetDotNet, default: '8.0' }
    );
    expect(report.pass).toBe(false);
    expect(report.findings.length).toBe(2);
    expect(report.findings.some((f) => f.requirement === '17.4')).toBe(true);
    expect(report.findings.some((f) => f.requirement === '17.5')).toBe(true);
  });
});

describe('inventory bridge', () => {
  // A minimal fixture carrying the post-update (target) NodeVersion/DotNetVersion rows.
  const VSCODE_FIXTURE = `Description: VSCode bootstrap
Resources:
  VSCodeInstanceSSMDoc:
    Properties:
      Content:
        parameters:
          NodeVersion:
            type: String
            default: '22'
            allowedValues:
              - '24'
              - '22'
          DotNetVersion:
            type: String
            default: '10.0'
            allowedValues:
              - '10.0'
              - '8.0'
`;
  const contents: BootstrapTemplateContents = {
    vscodeServer: VSCODE_FIXTURE,
    workshopStack: '',
  };

  it('derives clean checker inputs from a post-update inventory', () => {
    const elements = buildBootstrapInventory(contents);
    const { node, dotnet } = inventoryToAllowedListInputs(elements);
    expect(node.allowed).toEqual(['24', '22']);
    expect(node.default).toBe('22');
    expect(dotnet.allowed).toEqual(['10.0', '8.0']);
    expect(dotnet.default).toBe('10.0');
  });

  it('passes the EOL check against a post-update inventory', () => {
    const elements = buildBootstrapInventory(contents);
    const report = checkBootstrapAllowedListsFromInventory(elements);
    expect(report.pass).toBe(true);
  });

  it('throws when required rows are absent from the inventory', () => {
    const sparse: BootstrapElement[] = [
      {
        file: 'static/cfn/vscode-server.yaml',
        location: 'Parameters.InstanceType.Default',
        currentValue: 't4g.medium',
        targetValue: 't4g.medium',
        dynamic: false,
        status: 'retained',
      },
    ];
    expect(() => inventoryToAllowedListInputs(sparse)).toThrow();
  });

  it('normalizeList round-trips through the bridge parser', () => {
    const elements = buildBootstrapInventory(contents);
    const allowedEl = elements.find((e) => e.location.endsWith('NodeVersion.allowedValues'));
    expect(allowedEl?.targetValue).toBe(normalizeList(['24', '22']));
  });
});
