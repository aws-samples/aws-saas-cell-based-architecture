/**
 * Unit tests for the Answer-Key Synchronizer and byte-comparator (CC10, task 14.1).
 *
 * Requirements covered: 14.1, 14.4, 14.5, 14.6.
 *
 * Feature: codebase-modernization-refresh
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  ANSWER_KEY_LOCATIONS,
  bytesIdentical,
  toBuffer,
  compareToSource,
  syncAnswerKey,
  syncAnswerKeys,
  isSyncFailure,
  isActivityComplete,
  syncFailureMessages,
  extractFencedBlock,
  listZipEntries,
  readZipEntry,
  resolveAnswerKeyCopies,
  syncAnswerKeyFromSources,
  type AnswerKeyCopies,
  type AnswerKeySpec,
} from './answerKeySynchronizer';

const SOURCE = 'export const cell = 42;';

/** All four copies identical to the source. */
function allIdentical(): AnswerKeyCopies {
  return {
    markdown: SOURCE,
    staticSolution: SOURCE,
    solutionZip: SOURCE,
    repoSolution: SOURCE,
  };
}

describe('byte-comparator', () => {
  it('bytesIdentical is true only for equal byte sequences', () => {
    expect(bytesIdentical(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(bytesIdentical(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(bytesIdentical(Buffer.from('abc'), Buffer.from('ab'))).toBe(false);
  });

  it('detects single-byte and trailing-whitespace divergence', () => {
    expect(compareToSource('a\n', 'a')).toBe('divergent');
    expect(compareToSource('a\n', 'a\n')).toBe('identical');
    expect(compareToSource('a\n', 'a\n ')).toBe('divergent');
  });

  it('treats string and equivalent UTF-8 Buffer as identical', () => {
    expect(compareToSource(SOURCE, Buffer.from(SOURCE, 'utf8'))).toBe('identical');
  });

  it('reports an absent copy as missing (Req 14.5)', () => {
    expect(compareToSource(SOURCE, undefined)).toBe('missing');
    expect(compareToSource(SOURCE, null)).toBe('missing');
  });

  it('toBuffer normalizes content and absence', () => {
    expect(toBuffer('x')).toEqual(Buffer.from('x'));
    expect(toBuffer(undefined)).toBeNull();
    expect(toBuffer(null)).toBeNull();
  });
});

describe('syncAnswerKey — all copies present and identical (Req 14.2, 14.3)', () => {
  const key = syncAnswerKey('lab01-stack', 'lib/CellStack.ts', SOURCE, allIdentical());

  it('reports allByteIdentical with no missing/divergent locations', () => {
    expect(key.allByteIdentical).toBe(true);
    expect(key.missingLocations).toEqual([]);
    expect(key.divergentLocations).toEqual([]);
  });

  it('is not a sync failure and the activity may complete (Req 14.6)', () => {
    expect(isSyncFailure(key)).toBe(false);
    expect(isActivityComplete(key)).toBe(true);
    expect(syncFailureMessages(key)).toEqual([]);
  });

  it('records each copy content', () => {
    expect(key.copies.markdown).toBe(SOURCE);
    expect(key.copies.repoSolution).toBe(SOURCE);
  });
});

describe('syncAnswerKey — divergent copy (Req 14.4)', () => {
  const copies = { ...allIdentical(), solutionZip: 'export const cell = 43;\n' };
  const key = syncAnswerKey('lab01-stack', 'lib/CellStack.ts', SOURCE, copies);

  it('records the divergent location and fails synchronization', () => {
    expect(key.divergentLocations).toEqual(['solutionZip']);
    expect(key.missingLocations).toEqual([]);
    expect(key.allByteIdentical).toBe(false);
    expect(isSyncFailure(key)).toBe(true);
  });

  it('does NOT mark the activity complete (Req 14.6)', () => {
    expect(isActivityComplete(key)).toBe(false);
  });

  it('failure message identifies the key and the diverging location (Req 14.4)', () => {
    const messages = syncFailureMessages(key);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('lab01-stack');
    expect(messages[0]).toContain('divergent');
    expect(messages[0]).toContain('solutionZip');
  });
});

describe('syncAnswerKey — missing copy (Req 14.5)', () => {
  const copies = { ...allIdentical(), markdown: undefined };
  const key = syncAnswerKey('lab04-product', 'src/product.py', SOURCE, copies);

  it('records the missing location and fails synchronization', () => {
    expect(key.missingLocations).toEqual(['markdown']);
    expect(key.divergentLocations).toEqual([]);
    expect(key.allByteIdentical).toBe(false);
    expect(isActivityComplete(key)).toBe(false);
  });

  it('failure message identifies the key and the missing location (Req 14.5)', () => {
    const messages = syncFailureMessages(key);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('lab04-product');
    expect(messages[0]).toContain('missing');
    expect(messages[0]).toContain('markdown');
  });
});

describe('syncAnswerKey — combined missing + divergent across locations', () => {
  const copies: AnswerKeyCopies = {
    markdown: SOURCE,
    staticSolution: undefined, // missing
    solutionZip: 'different\n', // divergent
    repoSolution: undefined, // missing
  };
  const key = syncAnswerKey('k', 'lib/x.ts', SOURCE, copies);

  it('enumerates all failing locations in canonical order', () => {
    expect(key.missingLocations).toEqual(['staticSolution', 'repoSolution']);
    expect(key.divergentLocations).toEqual(['solutionZip']);
    expect(key.allByteIdentical).toBe(false);
  });

  it('produces a message per failing location', () => {
    expect(syncFailureMessages(key)).toHaveLength(3);
  });
});

describe('syncAnswerKey — entirely absent key (all four missing, Req 14.5)', () => {
  const key = syncAnswerKey('absent', 'lib/x.ts', SOURCE, {});

  it('marks all four canonical locations missing', () => {
    expect(key.missingLocations).toEqual([...ANSWER_KEY_LOCATIONS]);
    expect(isActivityComplete(key)).toBe(false);
  });
});

describe('syncAnswerKeys — batch preserves order', () => {
  it('reconciles each key independently', () => {
    const results = syncAnswerKeys([
      { id: 'a', sourceFile: 'a.ts', source: SOURCE, copies: allIdentical() },
      {
        id: 'b',
        sourceFile: 'b.ts',
        source: SOURCE,
        copies: { ...allIdentical(), repoSolution: 'x' },
      },
    ]);
    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(isActivityComplete(results[0])).toBe(true);
    expect(isActivityComplete(results[1])).toBe(false);
  });
});

describe('extractFencedBlock', () => {
  const md = [
    '# Lab',
    'Intro prose.',
    '```typescript',
    'export const cell = 42;',
    '```',
    'More prose.',
    '```python',
    'print("hi")',
    '```',
  ].join('\n');

  it('extracts the first block by default', () => {
    expect(extractFencedBlock(md)).toBe('export const cell = 42;');
  });

  it('filters by language tag', () => {
    expect(extractFencedBlock(md, { lang: 'python' })).toBe('print("hi")');
  });

  it('filters by marker substring', () => {
    expect(extractFencedBlock(md, { marker: 'cell = 42' })).toBe(
      'export const cell = 42;'
    );
  });

  it('returns undefined when no block matches', () => {
    expect(extractFencedBlock(md, { lang: 'rust' })).toBeUndefined();
    expect(extractFencedBlock('no fences here')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Minimal ZIP writer used to exercise the reader against real archive bytes.
// ---------------------------------------------------------------------------

function makeZip(entries: { name: string; content: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const method = e.store ? 0 : 8;
    const data = e.store ? e.content : zlib.deflateRawSync(e.content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(0, 14); // crc (ignored by reader)
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(e.content.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(e.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

describe('ZIP entry reader', () => {
  const zip = makeZip([
    { name: 'solution/lab01/CellStack.ts', content: Buffer.from(SOURCE) },
    { name: 'solution/lab02/stored.txt', content: Buffer.from('stored bytes'), store: true },
  ]);

  it('lists entry names', () => {
    expect(listZipEntries(zip)).toEqual([
      'solution/lab01/CellStack.ts',
      'solution/lab02/stored.txt',
    ]);
  });

  it('reads a deflate-compressed entry byte-for-byte', () => {
    expect(readZipEntry(zip, 'solution/lab01/CellStack.ts')).toEqual(Buffer.from(SOURCE));
  });

  it('reads a stored (uncompressed) entry', () => {
    expect(readZipEntry(zip, 'solution/lab02/stored.txt')).toEqual(
      Buffer.from('stored bytes')
    );
  });

  it('returns undefined for a missing entry', () => {
    expect(readZipEntry(zip, 'nope.txt')).toBeUndefined();
  });

  it('returns undefined for a non-zip buffer', () => {
    expect(listZipEntries(Buffer.from('not a zip'))).toEqual([]);
    expect(readZipEntry(Buffer.from('not a zip'), 'x')).toBeUndefined();
  });
});

describe('filesystem/zip-backed syncAnswerKeyFromSources', () => {
  let repoRoot: string;
  let workshopRoot: string;

  const spec: AnswerKeySpec = {
    id: 'lab01-cell-stack',
    sourceFile: 'lib/CellStack.ts',
    repoSolutionFile: 'Solution/lab01/CellStack.ts',
    staticSolutionFile: 'static/solution/lab01/CellStack.ts',
    solutionZipFile: 'assets/solution.zip',
    solutionZipEntry: 'solution/lab01/CellStack.ts',
    markdownFile: 'content/lab01/index.en.md',
    markdownFence: { lang: 'typescript' },
  };

  function writeFile(root: string, rel: string, content: Buffer | string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-repo-'));
    workshopRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ws-'));
    writeFile(repoRoot, spec.sourceFile, SOURCE);
    writeFile(repoRoot, spec.repoSolutionFile, SOURCE);
    writeFile(workshopRoot, spec.staticSolutionFile, SOURCE);
    writeFile(
      workshopRoot,
      spec.markdownFile,
      ['# Lab 1', '```typescript', SOURCE.replace(/\n$/, ''), '```'].join('\n')
    );
    writeFile(
      workshopRoot,
      spec.solutionZipFile,
      makeZip([{ name: spec.solutionZipEntry, content: Buffer.from(SOURCE) }])
    );
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workshopRoot, { recursive: true, force: true });
  });

  it('resolves all four copies identical to the source', () => {
    const key = syncAnswerKeyFromSources(spec, { repoRoot, workshopRoot });
    expect(key.allByteIdentical).toBe(true);
    expect(isActivityComplete(key)).toBe(true);
  });

  it('reports a missing static/solution copy (Req 14.5)', () => {
    fs.rmSync(path.join(workshopRoot, spec.staticSolutionFile));
    const key = syncAnswerKeyFromSources(spec, { repoRoot, workshopRoot });
    expect(key.missingLocations).toContain('staticSolution');
    expect(isActivityComplete(key)).toBe(false);
  });

  it('reports a divergent repo Solution copy (Req 14.4)', () => {
    writeFile(repoRoot, spec.repoSolutionFile, 'export const cell = 99;\n');
    const key = syncAnswerKeyFromSources(spec, { repoRoot, workshopRoot });
    expect(key.divergentLocations).toContain('repoSolution');
    expect(isActivityComplete(key)).toBe(false);
  });

  it('reports a divergent zip entry when the archive content drifts', () => {
    writeFile(
      workshopRoot,
      spec.solutionZipFile,
      makeZip([{ name: spec.solutionZipEntry, content: Buffer.from('drifted\n') }])
    );
    const key = syncAnswerKeyFromSources(spec, { repoRoot, workshopRoot });
    expect(key.divergentLocations).toContain('solutionZip');
  });

  it('resolveAnswerKeyCopies returns raw contents for inspection', () => {
    const { source, copies } = resolveAnswerKeyCopies(spec, { repoRoot, workshopRoot });
    expect(toBuffer(source)).toEqual(Buffer.from(SOURCE));
    expect(compareToSource(source, copies.solutionZip)).toBe('identical');
  });
});
