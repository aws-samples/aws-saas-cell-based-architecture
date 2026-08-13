/**
 * Unit tests for the Artifact Untracker classifier (Design Component 8, CC8).
 *
 * Requirements covered: 8.1, 8.4, 8.6.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  classify,
  classifyWithSiblingSet,
  siblingTsPathFor,
  isArtifactCandidate,
  isAnswerKeyPath,
  isNegationRulePath,
  CELL_ROUTER_FUNCTIONS_DIR,
} from './artifactUntracker';

describe('siblingTsPathFor', () => {
  it('maps a .js file to its .ts sibling', () => {
    expect(siblingTsPathFor('lib/foo/CellStack.js')).toBe('lib/foo/CellStack.ts');
  });

  it('maps a .d.ts file to its .ts sibling (not foo.d.ts)', () => {
    expect(siblingTsPathFor('lib/foo/CellStack.d.ts')).toBe('lib/foo/CellStack.ts');
  });

  it('returns null for a non-candidate file', () => {
    expect(siblingTsPathFor('lib/foo/CellStack.ts')).toBeNull();
    expect(siblingTsPathFor('lib/foo/data.json')).toBeNull();
  });

  it('normalizes Windows separators', () => {
    expect(siblingTsPathFor('lib\\foo\\bar.js')).toBe('lib/foo/bar.ts');
  });
});

describe('isArtifactCandidate', () => {
  it('accepts .js and .d.ts, rejects .ts and others', () => {
    expect(isArtifactCandidate('a/b.js')).toBe(true);
    expect(isArtifactCandidate('a/b.d.ts')).toBe(true);
    expect(isArtifactCandidate('a/b.ts')).toBe(false);
    expect(isArtifactCandidate('a/b.json')).toBe(false);
  });
});

describe('classify — generated artifacts (Req 8.1)', () => {
  it('classifies a .js with a sibling .ts (outside preserved paths) as generated', () => {
    const result = classify('lib/cell-management-system/CellStack.js', true);
    expect(result.classification).toBe('generated');
    expect(result.hasSiblingTs).toBe(true);
    expect(result.preserveReason).toBeUndefined();
  });

  it('classifies a .d.ts with a sibling .ts as generated', () => {
    const result = classify('lib/cell-management-system/CellStack.d.ts', true);
    expect(result.classification).toBe('generated');
  });
});

describe('classify — no sibling .ts is preserved (Req 8.4)', () => {
  it('preserves a hand-authored .js with no sibling .ts', () => {
    const result = classify('bin/helper.js', false);
    expect(result.classification).toBe('preserved');
    expect(result.preserveReason).toBe('no-sibling-ts');
  });
});

describe('classify — cell-router.js negation rule (Req 8.4)', () => {
  const cellRouter = `${CELL_ROUTER_FUNCTIONS_DIR}/cell-router.js`;

  it('always preserves cell-router.js via the negation rule, even if a sibling .ts were present', () => {
    // cell-router.js has no sibling .ts in practice; assert the negation rule is
    // the governing reason regardless of the sibling flag.
    expect(classify(cellRouter, false).classification).toBe('preserved');
    expect(classify(cellRouter, false).preserveReason).toBe('negation-rule');
    expect(classify(cellRouter, true).classification).toBe('preserved');
    expect(classify(cellRouter, true).preserveReason).toBe('negation-rule');
  });

  it('isNegationRulePath only matches .js under the functions dir', () => {
    expect(isNegationRulePath(cellRouter)).toBe(true);
    expect(isNegationRulePath(`${CELL_ROUTER_FUNCTIONS_DIR}/cell-router.d.ts`)).toBe(false);
    expect(isNegationRulePath('lib/other/cell-router.js')).toBe(false);
  });
});

describe('classify — Solution/* answer keys (Req 8.6)', () => {
  it('preserves a Solution answer key even when it has a sibling .ts', () => {
    const result = classify('Solution/lab01/cell-management-system-stack.js', true);
    expect(result.classification).toBe('preserved');
    expect(result.preserveReason).toBe('answer-key');
    // the sibling flag is still recorded faithfully
    expect(result.hasSiblingTs).toBe(true);
  });

  it('preserves the Solution .d.ts answer key as well', () => {
    const result = classify('Solution/lab03/observability-stack.d.ts', true);
    expect(result.classification).toBe('preserved');
    expect(result.preserveReason).toBe('answer-key');
  });

  it('isAnswerKeyPath matches any path with a Solution segment', () => {
    expect(isAnswerKeyPath('Solution/lab01/x.js')).toBe(true);
    expect(isAnswerKeyPath('lib/Solution/x.js')).toBe(true);
    expect(isAnswerKeyPath('lib/cell/x.js')).toBe(false);
  });
});

describe('classify — rejects non-candidates', () => {
  it('throws when given a .ts file', () => {
    expect(() => classify('lib/foo/CellStack.ts', false)).toThrow(/candidate/);
  });
});

describe('classifyWithSiblingSet — derives the sibling flag from a known path set', () => {
  const tracked = new Set<string>([
    'lib/cell-management-system/CellStack.ts',
    'lib/cell-management-system/CellStack.js',
    'Solution/lab01/cell-management-system-stack.ts',
    'Solution/lab01/cell-management-system-stack.js',
    `${CELL_ROUTER_FUNCTIONS_DIR}/cell-router.js`,
    'bin/saas-cell-based-architecture.ts',
  ]);

  it('marks CellStack.js generated because its .ts sibling is in the set', () => {
    const result = classifyWithSiblingSet(
      'lib/cell-management-system/CellStack.js',
      tracked
    );
    expect(result.classification).toBe('generated');
    expect(result.hasSiblingTs).toBe(true);
  });

  it('keeps the Solution answer key preserved despite the sibling being present', () => {
    const result = classifyWithSiblingSet(
      'Solution/lab01/cell-management-system-stack.js',
      tracked
    );
    expect(result.classification).toBe('preserved');
    expect(result.preserveReason).toBe('answer-key');
  });

  it('keeps cell-router.js preserved (no sibling .ts in the set, plus negation rule)', () => {
    const result = classifyWithSiblingSet(
      `${CELL_ROUTER_FUNCTIONS_DIR}/cell-router.js`,
      tracked
    );
    expect(result.classification).toBe('preserved');
    expect(result.preserveReason).toBe('negation-rule');
    expect(result.hasSiblingTs).toBe(false);
  });
});
