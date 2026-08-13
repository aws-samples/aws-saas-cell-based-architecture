/**
 * Answer-Key Synchronizer and byte-comparator (Design Component 9 sub-component,
 * CC10: "Answer-key lockstep across four locations").
 *
 * Each Answer_Key exists in FOUR canonical locations (Req 14, Glossary):
 *   1. `markdown`       — a fenced code block inside the workshop lab markdown,
 *   2. `staticSolution` — a file in the workshop `static/solution/*` tree,
 *   3. `solutionZip`    — an entry inside the workshop `assets/solution.zip` archive,
 *   4. `repoSolution`   — a file in the repository `Solution/*` directory.
 *
 * The refreshed repository source file is the single source of truth. After the
 * four copies are regenerated (task 14.2), every copy MUST be byte-for-byte
 * identical to that refreshed source.
 *
 * Behavior (Requirements 14.1, 14.4, 14.5, 14.6):
 *   - 14.1: when a source file that has a corresponding Answer_Key is modified,
 *     every duplicated copy is reconciled within the same activity. This module
 *     performs that reconciliation check.
 *   - 14.4: a copy that is PRESENT but differs from the refreshed source is a
 *     synchronization failure recorded in `divergentLocations`, and the failure
 *     message identifies the affected key and each diverging copy location.
 *   - 14.5: a copy that is ABSENT from any of the four target locations is a
 *     synchronization failure recorded in `missingLocations`, and the failure
 *     message identifies the affected key and the missing location.
 *   - 14.6: if ANY synchronization failure is reported for an Answer_Key, the
 *     refresh activity for that key MUST NOT be reported as complete
 *     ({@link isActivityComplete} returns `false`).
 *
 * The byte-comparator ({@link compareToSource}, {@link bytesIdentical}) and the
 * aggregator ({@link syncAnswerKey}) are PURE functions over in-memory content
 * buffers/strings, so they are unit- and property-testable without touching the
 * filesystem (the property test is task 14.3). A filesystem/zip-backed variant
 * ({@link syncAnswerKeyFromSources}) resolves the four physical locations —
 * including reading an entry out of `assets/solution.zip` — and then delegates to
 * the pure aggregator.
 *
 * Interface (design): `syncAnswerKeys()`.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { AnswerKey } from './models';

/** The four canonical Answer_Key copy locations, in a stable order (Req 14.2). */
export const ANSWER_KEY_LOCATIONS = [
  'markdown',
  'staticSolution',
  'solutionZip',
  'repoSolution',
] as const;

/** A canonical Answer_Key location key. */
export type AnswerKeyLocation = (typeof ANSWER_KEY_LOCATIONS)[number];

/** Human-readable labels for each location, used in failure messages (Req 14.4, 14.5). */
export const ANSWER_KEY_LOCATION_LABELS: Record<AnswerKeyLocation, string> = {
  markdown: 'workshop markdown fenced block',
  staticSolution: 'static/solution/* tree',
  solutionZip: 'assets/solution.zip archive',
  repoSolution: 'repository Solution/* directory',
};

/**
 * Raw content of a single copy: a {@link Buffer} (preferred, byte-exact), a
 * string (decoded as UTF-8 bytes for comparison), or `undefined`/`null` when the
 * copy is ABSENT from its location (Req 14.5).
 */
export type CopyContent = Buffer | string | undefined | null;

/** The four copies of an Answer_Key, keyed by canonical location. */
export type AnswerKeyCopies = Partial<Record<AnswerKeyLocation, CopyContent>>;

/** Per-location comparison outcome against the refreshed source. */
export type CopyComparison = 'identical' | 'divergent' | 'missing';

/** Normalize {@link CopyContent} to a {@link Buffer}, or `null` when absent. */
export function toBuffer(content: CopyContent): Buffer | null {
  if (content === undefined || content === null) {
    return null;
  }
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
}

/**
 * Pure byte-comparator: `true` iff both buffers contain exactly the same bytes.
 * Two absent (`null`) operands are NOT considered identical here — absence is
 * handled by {@link compareToSource} as a `missing` outcome (Req 14.5).
 */
export function bytesIdentical(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

/**
 * Compare a single copy against the refreshed source, byte-for-byte.
 *   - `missing`   — the copy is absent (Req 14.5),
 *   - `divergent` — the copy is present but differs from the source (Req 14.4),
 *   - `identical` — the copy is present and byte-for-byte identical (Req 14.3).
 */
export function compareToSource(source: CopyContent, copy: CopyContent): CopyComparison {
  const copyBuf = toBuffer(copy);
  if (copyBuf === null) {
    return 'missing';
  }
  const sourceBuf = toBuffer(source);
  if (sourceBuf === null) {
    // No source to compare against: treat the present copy as divergent so the
    // failure surfaces rather than being silently accepted.
    return 'divergent';
  }
  return bytesIdentical(sourceBuf, copyBuf) ? 'identical' : 'divergent';
}

/**
 * Aggregate the four copies of one Answer_Key against the refreshed source into
 * an {@link AnswerKey} record (PURE).
 *
 * `allByteIdentical` is `true` iff ALL four canonical copies are present and each
 * is byte-for-byte identical to the refreshed source (Req 14.2, 14.3).
 * `missingLocations` (Req 14.5) and `divergentLocations` (Req 14.4) enumerate the
 * failing locations by canonical key, in {@link ANSWER_KEY_LOCATIONS} order.
 *
 * @param id          stable Answer_Key id.
 * @param sourceFile  repository source path the key is derived from.
 * @param source      refreshed source content (the source of truth).
 * @param copies      the four copies keyed by canonical location.
 */
export function syncAnswerKey(
  id: string,
  sourceFile: string,
  source: CopyContent,
  copies: AnswerKeyCopies
): AnswerKey {
  const missingLocations: string[] = [];
  const divergentLocations: string[] = [];
  const resultCopies: AnswerKey['copies'] = {};

  for (const location of ANSWER_KEY_LOCATIONS) {
    const copy = copies[location];
    const buf = toBuffer(copy);
    if (buf !== null) {
      resultCopies[location] = buf.toString('utf8');
    }

    const outcome = compareToSource(source, copy);
    if (outcome === 'missing') {
      missingLocations.push(location);
    } else if (outcome === 'divergent') {
      divergentLocations.push(location);
    }
  }

  const allByteIdentical =
    missingLocations.length === 0 && divergentLocations.length === 0;

  return {
    id,
    sourceFile,
    copies: resultCopies,
    allByteIdentical,
    missingLocations,
    divergentLocations,
  };
}

/**
 * `syncAnswerKeys()` (design interface): reconcile a batch of Answer_Keys.
 * Each entry pairs an Answer_Key's refreshed source with its four copies; the
 * result preserves input order. PURE.
 */
export function syncAnswerKeys(
  keys: {
    id: string;
    sourceFile: string;
    source: CopyContent;
    copies: AnswerKeyCopies;
  }[]
): AnswerKey[] {
  return keys.map((k) => syncAnswerKey(k.id, k.sourceFile, k.source, k.copies));
}

/**
 * `true` iff the Answer_Key has at least one synchronization failure — a missing
 * copy (Req 14.5) or a divergent copy (Req 14.4).
 */
export function isSyncFailure(key: AnswerKey): boolean {
  return (
    !key.allByteIdentical ||
    key.missingLocations.length > 0 ||
    key.divergentLocations.length > 0
  );
}

/**
 * Req 14.6: the refresh activity for an Answer_Key may be reported complete ONLY
 * when there is no synchronization failure for that key.
 */
export function isActivityComplete(key: AnswerKey): boolean {
  return !isSyncFailure(key);
}

/**
 * Build human-readable synchronization-failure messages for an Answer_Key,
 * identifying the affected key and each missing (Req 14.5) / divergent (Req 14.4)
 * copy location. Returns an empty array when the key is fully synchronized.
 */
export function syncFailureMessages(key: AnswerKey): string[] {
  const messages: string[] = [];
  for (const location of key.missingLocations as AnswerKeyLocation[]) {
    messages.push(
      `Answer_Key "${key.id}" (source ${key.sourceFile}): missing copy in ` +
        `${ANSWER_KEY_LOCATION_LABELS[location] ?? location} [${location}]`
    );
  }
  for (const location of key.divergentLocations as AnswerKeyLocation[]) {
    messages.push(
      `Answer_Key "${key.id}" (source ${key.sourceFile}): divergent copy in ` +
        `${ANSWER_KEY_LOCATION_LABELS[location] ?? location} [${location}]`
    );
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Minimal ZIP entry reader (for the `assets/solution.zip` location)
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Locate the End-Of-Central-Directory record offset, scanning from the tail. */
function findEocdOffset(buf: Buffer): number {
  // EOCD is 22 bytes minimum and may be followed by a variable-length comment.
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  return -1;
}

/** A parsed central-directory entry (only the fields the reader needs). */
interface ZipCentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** Parse the central directory into a list of entries. */
function parseCentralDirectory(buf: Buffer): ZipCentralEntry[] {
  const eocd = findEocdOffset(buf);
  if (eocd < 0) {
    return [];
  }
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipCentralEntry[] = [];

  for (let i = 0; i < total; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      break;
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate (or copy, for STORED) an entry's raw bytes into its uncompressed form. */
function extractEntryData(buf: Buffer, entry: ZipCentralEntry): Buffer | undefined {
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== LOCAL_HEADER_SIGNATURE) {
    return undefined;
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) {
    // STORED (no compression).
    return Buffer.from(raw);
  }
  if (entry.method === 8) {
    // DEFLATE (raw deflate stream).
    return zlib.inflateRawSync(raw);
  }
  return undefined;
}

/** List the entry names contained in a ZIP archive buffer. */
export function listZipEntries(zipBuffer: Buffer): string[] {
  return parseCentralDirectory(zipBuffer).map((e) => e.name);
}

/**
 * Read a single entry's decompressed content from a ZIP archive buffer.
 * Returns `undefined` when the entry is absent or uses an unsupported
 * compression method, so callers treat it as a `missing` copy (Req 14.5).
 */
export function readZipEntry(zipBuffer: Buffer, entryName: string): Buffer | undefined {
  const entries = parseCentralDirectory(zipBuffer);
  const entry = entries.find((e) => e.name === entryName);
  if (!entry) {
    return undefined;
  }
  try {
    return extractEntryData(zipBuffer, entry);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Markdown fenced-block extraction (for the `markdown` location)
// ---------------------------------------------------------------------------

/** How to locate the Answer_Key fenced block inside a workshop markdown file. */
export interface MarkdownFenceSelector {
  /** Only consider fenced blocks with this language tag (e.g. "typescript"). */
  lang?: string;
  /** Zero-based index among the matching fenced blocks (default 0). */
  index?: number;
  /** Only match a fenced block whose content includes this marker substring. */
  marker?: string;
}

/**
 * Extract a fenced code block's content from markdown. Supports ``` and ~~~
 * fences. Returns `undefined` when no block matches the selector — treated as a
 * `missing` markdown copy (Req 14.5). The returned content excludes the fence
 * lines and the trailing newline before the closing fence.
 */
export function extractFencedBlock(
  markdown: string,
  selector: MarkdownFenceSelector = {}
): string | undefined {
  const lines = markdown.split('\n');
  const blocks: { lang: string; content: string }[] = [];
  let open: { fence: string; lang: string; body: string[] } | null = null;

  for (const line of lines) {
    const fenceMatch = /^(\s*)(```+|~~~+)(.*)$/.exec(line);
    if (open) {
      // Look for a closing fence of the same type.
      if (fenceMatch && fenceMatch[2][0] === open.fence[0] && fenceMatch[3].trim() === '') {
        blocks.push({ lang: open.lang, content: open.body.join('\n') });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      open = { fence: fenceMatch[2], lang: fenceMatch[3].trim(), body: [] };
    }
  }

  let candidates = blocks;
  if (selector.lang !== undefined) {
    candidates = candidates.filter((b) => b.lang === selector.lang);
  }
  if (selector.marker !== undefined) {
    candidates = candidates.filter((b) => b.content.includes(selector.marker!));
  }
  const idx = selector.index ?? 0;
  return candidates[idx]?.content;
}

// ---------------------------------------------------------------------------
// Filesystem / zip-backed variant
// ---------------------------------------------------------------------------

/**
 * Physical location specification for one Answer_Key's four copies. Paths are
 * resolved against `repoRoot` (the `sourceFile` and `repoSolution` copy) or
 * `workshopRoot` (the `markdown`, `staticSolution`, and `solutionZip` copies).
 */
export interface AnswerKeySpec {
  /** stable Answer_Key id. */
  id: string;
  /** repository-relative path to the refreshed source of truth. */
  sourceFile: string;
  /** repository-relative path under `Solution/`. */
  repoSolutionFile: string;
  /** workshop-relative path under `static/solution/`. */
  staticSolutionFile: string;
  /** workshop-relative path to the solution archive (e.g. `assets/solution.zip`). */
  solutionZipFile: string;
  /** entry name within the solution archive. */
  solutionZipEntry: string;
  /** workshop-relative markdown file holding the fenced answer-key block. */
  markdownFile: string;
  /** how to locate the fenced block inside `markdownFile`. */
  markdownFence?: MarkdownFenceSelector;
}

/** Roots and optional overrides for resolving an {@link AnswerKeySpec}. */
export interface AnswerKeyResolveOptions {
  /** repository root (default: three levels up from this module). */
  repoRoot?: string;
  /** workshop content root. */
  workshopRoot: string;
}

/** Read a file as a Buffer, returning `undefined` when it is absent/unreadable. */
function readFileOrUndefined(file: string): Buffer | undefined {
  try {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return fs.readFileSync(file);
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/**
 * Resolve the four physical copies (and the refreshed source) for an
 * {@link AnswerKeySpec} from the filesystem and the `assets/solution.zip`
 * archive. Any unreadable/absent location yields `undefined` (a `missing` copy).
 */
export function resolveAnswerKeyCopies(
  spec: AnswerKeySpec,
  options: AnswerKeyResolveOptions
): { source: CopyContent; copies: AnswerKeyCopies } {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, '../../..');
  const workshopRoot = options.workshopRoot;

  const source = readFileOrUndefined(path.resolve(repoRoot, spec.sourceFile));
  const repoSolution = readFileOrUndefined(path.resolve(repoRoot, spec.repoSolutionFile));
  const staticSolution = readFileOrUndefined(
    path.resolve(workshopRoot, spec.staticSolutionFile)
  );

  const zipBuffer = readFileOrUndefined(path.resolve(workshopRoot, spec.solutionZipFile));
  const solutionZip =
    zipBuffer !== undefined ? readZipEntry(zipBuffer, spec.solutionZipEntry) : undefined;

  const markdownBuffer = readFileOrUndefined(path.resolve(workshopRoot, spec.markdownFile));
  const markdown =
    markdownBuffer !== undefined
      ? extractFencedBlock(markdownBuffer.toString('utf8'), spec.markdownFence)
      : undefined;

  return {
    source,
    copies: { markdown, staticSolution, solutionZip, repoSolution },
  };
}

/**
 * Filesystem/zip-backed `syncAnswerKeys()` for a single key: resolve the four
 * physical copies, then delegate to the pure {@link syncAnswerKey} aggregator.
 */
export function syncAnswerKeyFromSources(
  spec: AnswerKeySpec,
  options: AnswerKeyResolveOptions
): AnswerKey {
  const { source, copies } = resolveAnswerKeyCopies(spec, options);
  return syncAnswerKey(spec.id, spec.sourceFile, source, copies);
}

/** Filesystem/zip-backed `syncAnswerKeys()` for a batch of specs. */
export function syncAnswerKeysFromSources(
  specs: AnswerKeySpec[],
  options: AnswerKeyResolveOptions
): AnswerKey[] {
  return specs.map((spec) => syncAnswerKeyFromSources(spec, options));
}
