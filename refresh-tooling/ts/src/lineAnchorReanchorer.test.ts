/**
 * Unit tests for the Line-Anchor Re-anchoring sub-component (Design Component 9, CC9).
 *
 * Requirements covered: 11.1, 11.2, 11.5.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  findRegionStartLine,
  reanchorAnchor,
  reanchor,
  summarizeReanchor,
  SourceContentProvider,
} from './lineAnchorReanchorer';
import type { LineAnchor } from './models';

const SOURCE = [
  "import { Stack } from 'aws-cdk-lib';", // line 1
  '', // line 2
  'export class CellStack extends Stack {', // line 3
  '  constructor(scope, id, props) {', // line 4
  '    super(scope, id);', // line 5
  "    if (props.cellSize == 'S') {", // line 6
  '      this.capacity = 10;', // line 7
  '    }', // line 8
  '  }', // line 9
  '}', // line 10
].join('\n');

function anchor(overrides: Partial<LineAnchor> = {}): LineAnchor {
  return {
    workshopFile: 'content/lab01/index.en.md',
    anchorKind: 'highlightLinesStart',
    sourceFile: 'lib/cell-management-system/CellStack.ts',
    recordedLine: 6,
    targetRegionMarker: "if (props.cellSize == 'S')",
    status: 'unchanged',
    ...overrides,
  };
}

describe('findRegionStartLine (pure marker matching)', () => {
  it('returns the 1-based line of a single-line marker', () => {
    expect(findRegionStartLine(SOURCE, "if (props.cellSize == 'S')")).toBe(6);
  });

  it('returns line 1 for a marker on the first line', () => {
    expect(findRegionStartLine(SOURCE, "import { Stack }")).toBe(1);
  });

  it('returns the starting line for a multi-line marker', () => {
    const marker = "  constructor(scope, id, props) {\n    super(scope, id);";
    expect(findRegionStartLine(SOURCE, marker)).toBe(4);
  });

  it('returns null when the marker is absent', () => {
    expect(findRegionStartLine(SOURCE, 'this marker does not exist')).toBeNull();
  });

  it('returns null for an empty marker', () => {
    expect(findRegionStartLine(SOURCE, '')).toBeNull();
  });

  it('is insensitive to CRLF line endings', () => {
    const crlf = SOURCE.replace(/\n/g, '\r\n');
    expect(findRegionStartLine(crlf, "if (props.cellSize == 'S')")).toBe(6);
  });

  it('reports the first occurrence when the marker repeats', () => {
    const content = 'foo\nmarker\nbar\nmarker\n';
    expect(findRegionStartLine(content, 'marker')).toBe(2);
  });
});

describe('reanchorAnchor — unchanged (Req 11.1)', () => {
  it('reports unchanged and sets resolvedLine when the marker is already at recordedLine', () => {
    const result = reanchorAnchor(anchor({ recordedLine: 6 }), SOURCE);
    expect(result.status).toBe('unchanged');
    expect(result.resolvedLine).toBe(6);
  });
});

describe('reanchorAnchor — updated (Req 11.2)', () => {
  it('rewrites resolvedLine to the current 1-based line when the region has moved', () => {
    // Two lines inserted above the region: the marker now sits on line 8.
    const shifted = '// added\n// added\n' + SOURCE;
    const result = reanchorAnchor(anchor({ recordedLine: 6 }), shifted);
    expect(result.status).toBe('updated');
    expect(result.resolvedLine).toBe(8);
  });

  it('does not mutate the input anchor', () => {
    const input = anchor({ recordedLine: 6 });
    const shifted = '// added\n' + SOURCE;
    reanchorAnchor(input, shifted);
    expect(input.resolvedLine).toBeUndefined();
    expect(input.status).toBe('unchanged');
    expect(input.recordedLine).toBe(6);
  });
});

describe('reanchorAnchor — unresolved (Req 11.5)', () => {
  it('leaves the anchor unchanged and reports unresolved when the marker is gone', () => {
    const removed = SOURCE.replace("    if (props.cellSize == 'S') {", '    // region removed');
    const input = anchor({ recordedLine: 6 });
    const result = reanchorAnchor(input, removed);
    expect(result.status).toBe('unresolved');
    expect(result.resolvedLine).toBeUndefined();
    // recordedLine preserved unchanged
    expect(result.recordedLine).toBe(6);
  });
});

describe('reanchor — list over a content provider', () => {
  const anchors: LineAnchor[] = [
    anchor({ recordedLine: 6, targetRegionMarker: "if (props.cellSize == 'S')" }),
    anchor({ recordedLine: 1, targetRegionMarker: 'import { Stack }' }),
    anchor({ recordedLine: 99, targetRegionMarker: 'not present at all' }),
  ];
  const provider: SourceContentProvider = () => SOURCE;

  it('classifies each anchor as unchanged / updated / unresolved', () => {
    const [a, b, c] = reanchor(anchors, provider);
    expect(a.status).toBe('unchanged');
    expect(a.resolvedLine).toBe(6);
    expect(b.status).toBe('unchanged');
    expect(b.resolvedLine).toBe(1);
    expect(c.status).toBe('unresolved');
    expect(c.resolvedLine).toBeUndefined();
  });

  it('treats a missing source file as unresolved (Req 11.5)', () => {
    const missing: SourceContentProvider = () => null;
    const [a] = reanchor([anchor({ recordedLine: 6 })], missing);
    expect(a.status).toBe('unresolved');
    expect(a.resolvedLine).toBeUndefined();
  });
});

describe('summarizeReanchor', () => {
  it('counts updated / unchanged / unresolved and collects unresolved anchors', () => {
    const results = reanchor(
      [
        anchor({ recordedLine: 6, targetRegionMarker: "if (props.cellSize == 'S')" }),
        anchor({ recordedLine: 99, targetRegionMarker: 'import { Stack }' }),
        anchor({ recordedLine: 5, targetRegionMarker: 'missing region' }),
      ],
      () => SOURCE
    );
    const summary = summarizeReanchor(results);
    expect(summary.total).toBe(3);
    expect(summary.unchanged).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.unresolved).toBe(1);
    expect(summary.unresolvedAnchors).toHaveLength(1);
    expect(summary.unresolvedAnchors[0].targetRegionMarker).toBe('missing region');
  });
});
