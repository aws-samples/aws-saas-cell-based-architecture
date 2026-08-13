/**
 * Line-Anchor Re-anchoring sub-component (Design Component 9, CC9).
 *
 * Re-anchors a workshop {@link LineAnchor} against the post-refresh repository
 * source. Each anchor carries a stable content marker (`targetRegionMarker`,
 * e.g. `async function handler(event)` for `cell-router.js`, the
 * `if (props.cellSize == 'S')` block for `CellStack.ts`, or the
 * `"Deployment Succeeded"` state for `deploymentstatemachine.asl.json`). The
 * re-anchorer locates that marker in the current source file and rewrites the
 * anchor to the region's current 1-based line. Because anchors are matched by
 * CONTENT and not by their stored number, insertions/deletions above the region
 * are absorbed automatically.
 *
 * Behavior (Requirements 11.1, 11.2, 11.5):
 *   - 11.1: re-validate an anchor by comparing its recorded line against the
 *     current location of its target code region.
 *   - 11.2: rewrite the anchor so its value exactly equals the current 1-based
 *     line position of the target region in the post-refresh source file.
 *   - 11.5: IF the marker cannot be located in the post-refresh source file,
 *     leave the anchor unchanged and report it `unresolved` (its `resolvedLine`
 *     is left undefined and `recordedLine` is preserved).
 *
 * Status semantics on the returned anchor:
 *   - `updated`    — marker found at a line different from `recordedLine`;
 *                    `resolvedLine` is set to the new 1-based line.
 *   - `unchanged`  — marker found at exactly `recordedLine`; `resolvedLine` is
 *                    set (equal to `recordedLine`).
 *   - `unresolved` — marker not found; anchor left unchanged (Req 11.5).
 *
 * The core matching ({@link findRegionStartLine}, {@link reanchorAnchor}) is a
 * PURE function over file content + marker, so it is unit- and property-testable
 * without touching the filesystem (the property test is task 13.3). A
 * filesystem-backed variant ({@link reanchorFromFilesystem}) reads the repo
 * source files for the actual lab01–lab05 re-anchoring (task 13.2).
 *
 * Interface (design): `reanchor()`.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LineAnchor } from './models';

/** Normalize CRLF / lone-CR line endings to `\n` so line counting is stable. */
function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Locate a stable content marker in `content` and return the 1-based line on
 * which the marker BEGINS, or `null` when the marker is absent. PURE.
 *
 * The marker may be a single line (e.g. `if (props.cellSize == 'S')`) or span
 * multiple lines; matching is by substring over the newline-normalized content,
 * and the reported line is the line containing the first character of the match.
 * The first occurrence wins.
 */
export function findRegionStartLine(content: string, marker: string): number | null {
  if (marker.length === 0) {
    return null;
  }
  const normalizedContent = normalizeNewlines(content);
  const normalizedMarker = normalizeNewlines(marker);
  const idx = normalizedContent.indexOf(normalizedMarker);
  if (idx === -1) {
    return null;
  }
  // 1-based line = number of newlines before the match + 1.
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (normalizedContent.charCodeAt(i) === 10 /* '\n' */) {
      line++;
    }
  }
  return line;
}

/**
 * Re-anchor a single {@link LineAnchor} against the current content of its
 * target source file. PURE: operates only on the supplied content string.
 *
 * Returns a NEW anchor; the input is never mutated.
 *   - marker found at `recordedLine`         -> `{ status: 'unchanged', resolvedLine }`
 *   - marker found at a different line        -> `{ status: 'updated',   resolvedLine }`
 *   - marker not found (Req 11.5)             -> `{ status: 'unresolved' }`, anchor unchanged
 */
export function reanchorAnchor(anchor: LineAnchor, sourceContent: string): LineAnchor {
  const foundLine = findRegionStartLine(sourceContent, anchor.targetRegionMarker);

  if (foundLine === null) {
    // Req 11.5: leave unchanged, report unresolved; do not set resolvedLine.
    return {
      ...anchor,
      resolvedLine: undefined,
      status: 'unresolved',
    };
  }

  // Req 11.1 / 11.2: compare against recorded line and rewrite to the current line.
  return {
    ...anchor,
    resolvedLine: foundLine,
    status: foundLine === anchor.recordedLine ? 'unchanged' : 'updated',
  };
}

/**
 * A provider that returns the current content of a repository source file, or
 * `null` / `undefined` when the file cannot be read. Used to keep
 * {@link reanchor} pure and testable.
 */
export type SourceContentProvider = (sourceFile: string) => string | null | undefined;

/**
 * Re-anchor a list of {@link LineAnchor}s using a content provider keyed by each
 * anchor's `sourceFile`. PURE relative to the provider.
 *
 * When the provider yields no content for an anchor's source file, the anchor is
 * reported `unresolved` and left unchanged (Req 11.5) — an unreadable/absent
 * source file is treated the same as an unlocatable region.
 */
export function reanchor(
  anchors: LineAnchor[],
  getContent: SourceContentProvider
): LineAnchor[] {
  return anchors.map((anchor) => {
    const content = getContent(anchor.sourceFile);
    if (content === null || content === undefined) {
      return {
        ...anchor,
        resolvedLine: undefined,
        status: 'unresolved',
      };
    }
    return reanchorAnchor(anchor, content);
  });
}

/**
 * Filesystem-backed variant: reads each anchor's `sourceFile` from disk and
 * re-anchors it. `repoRoot`, when supplied, is prepended to relative
 * `sourceFile` paths before reading; absolute paths are used as-is.
 *
 * A missing or unreadable source file yields an `unresolved` anchor (Req 11.5)
 * rather than throwing, so a single bad path never aborts the batch.
 */
export function reanchorFromFilesystem(
  anchors: LineAnchor[],
  repoRoot?: string
): LineAnchor[] {
  return reanchor(anchors, (sourceFile) => {
    const resolved =
      repoRoot && !path.isAbsolute(sourceFile)
        ? path.join(repoRoot, sourceFile)
        : sourceFile;
    try {
      return fs.readFileSync(resolved, 'utf8');
    } catch {
      return null;
    }
  });
}

/**
 * Summarize a re-anchored batch into the counts the Phase-2 workshop SyncReport
 * (task 19.1) consumes. `unresolved > 0` blocks workshop completion (Req 11.5).
 */
export interface ReanchorSummary {
  total: number;
  updated: number;
  unchanged: number;
  unresolved: number;
  /** anchors that could not be located, for the SyncReport failure detail (Req 11.5) */
  unresolvedAnchors: LineAnchor[];
}

/** Build a {@link ReanchorSummary} from a list of re-anchored anchors. */
export function summarizeReanchor(results: LineAnchor[]): ReanchorSummary {
  const unresolvedAnchors = results.filter((a) => a.status === 'unresolved');
  return {
    total: results.length,
    updated: results.filter((a) => a.status === 'updated').length,
    unchanged: results.filter((a) => a.status === 'unchanged').length,
    unresolved: unresolvedAnchors.length,
    unresolvedAnchors,
  };
}
