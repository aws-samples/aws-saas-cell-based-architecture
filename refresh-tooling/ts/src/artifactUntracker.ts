/**
 * Artifact Untracker classifier (Design Component 8, CC8).
 *
 * Classifies a repository `.js` / `.d.ts` file as a generated build artifact
 * (safe to untrack) or a preserved source that must remain tracked.
 *
 * Behavior (Requirements 8.1, 8.4, 8.6):
 *   - 8.1: a `.js` / `.d.ts` file is "generated" IFF it has a sibling `.ts`
 *     source of the same base name in the same directory AND it is not in a
 *     preserved path.
 *   - 8.4: intentionally committed `.js` / `.d.ts` sources that lack a sibling
 *     `.ts` are PRESERVED — including the CloudFront Function `cell-router.js`,
 *     which is kept tracked by the `.gitignore` negation rule
 *     `!lib/application-plane/common-components/cell-router/src/functions/*.js`.
 *   - 8.6: files under `Solution/*` are committed Answer_Keys required for
 *     workshop synchronization and are PRESERVED even when they have a sibling
 *     `.ts` and otherwise match the `.js` / `.d.ts` ignore globs.
 *
 * The "generated" predicate is therefore the discriminator that protects
 * `cell-router.js` (no sibling `.ts`, plus the negation rule) and the
 * `Solution/*` answer keys (sibling `.ts` present, but preserved).
 *
 * `classify` is a PURE function of a file path plus a sibling-existence flag, so
 * it is unit- and property-testable without touching the filesystem. Helper
 * variants derive that flag from a predicate ({@link classifyWithChecker}), a set
 * of known paths ({@link classifyWithSiblingSet}), or the real filesystem
 * ({@link classifyFromFilesystem}).
 *
 * Interface (design): `classify(file) -> generated | preserved`.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import type { ArtifactClassification } from './models';

/**
 * Directory (as a normalized path fragment) protected by the `.gitignore`
 * negation rule that keeps the CloudFront Function source tracked (Req 8.4–8.5):
 * `!lib/application-plane/common-components/cell-router/src/functions/*.js`.
 */
export const CELL_ROUTER_FUNCTIONS_DIR =
  'lib/application-plane/common-components/cell-router/src/functions';

/** Repository directory holding committed Answer_Key copies (Req 8.6). */
export const ANSWER_KEY_ROOT = 'Solution';

/** Normalize Windows-style separators so matching is platform-independent. */
function normalize(file: string): string {
  return file.replace(/\\/g, '/');
}

/** Split a normalized path into non-empty segments. */
function segments(file: string): string[] {
  return normalize(file)
    .split('/')
    .filter((s) => s.length > 0);
}

/**
 * True iff `file` is a build-artifact CANDIDATE: a `.js` or `.d.ts` file. These
 * are the only extensions the classifier considers; any other file is outside
 * the scope of CC8 untracking.
 */
export function isArtifactCandidate(file: string): boolean {
  const f = normalize(file);
  return f.endsWith('.js') || f.endsWith('.d.ts');
}

/**
 * Compute the sibling `.ts` source path of the same base name, in the same
 * directory, for a candidate `.js` / `.d.ts` file.
 *
 * `foo.js`   -> `foo.ts`
 * `foo.d.ts` -> `foo.ts`
 *
 * Returns `null` when `file` is not a `.js` / `.d.ts` candidate.
 */
export function siblingTsPathFor(file: string): string | null {
  const f = normalize(file);
  if (f.endsWith('.d.ts')) {
    return `${f.slice(0, -'.d.ts'.length)}.ts`;
  }
  if (f.endsWith('.js')) {
    return `${f.slice(0, -'.js'.length)}.ts`;
  }
  return null;
}

/** True iff the file lives under a `Solution/` directory (Req 8.6). */
export function isAnswerKeyPath(file: string): boolean {
  return segments(file).includes(ANSWER_KEY_ROOT);
}

/**
 * True iff the file is a `.js` under the cell-router functions directory and is
 * therefore protected by the `.gitignore` negation rule (Req 8.4).
 */
export function isNegationRulePath(file: string): boolean {
  const f = normalize(file);
  return f.includes(`${CELL_ROUTER_FUNCTIONS_DIR}/`) && f.endsWith('.js');
}

/**
 * Classify a candidate `.js` / `.d.ts` file given whether its sibling `.ts`
 * source exists. PURE: no filesystem access.
 *
 * Preservation precedence (negation): a file is "generated" only when it has a
 * sibling `.ts` AND is in no preserved path. Otherwise it is "preserved", with a
 * reason recorded:
 *   - `answer-key`    — under `Solution/*` (Req 8.6); preserved even with a sibling `.ts`.
 *   - `negation-rule` — cell-router `*.js` kept tracked by the negation rule (Req 8.4).
 *   - `no-sibling-ts` — a hand-authored source with no generated origin (Req 8.4).
 *
 * @throws if `file` is not a `.js` / `.d.ts` candidate.
 */
export function classify(file: string, hasSiblingTs: boolean): ArtifactClassification {
  if (!isArtifactCandidate(file)) {
    throw new Error(
      `classify expects a .js or .d.ts candidate, received: ${file}`
    );
  }

  const path = normalize(file);

  // Req 8.6: Solution/* answer keys are preserved even when a sibling .ts exists.
  if (isAnswerKeyPath(path)) {
    return {
      path,
      hasSiblingTs,
      classification: 'preserved',
      preserveReason: 'answer-key',
    };
  }

  // Req 8.4: the cell-router CloudFront Function source is preserved by the
  // negation rule (it also has no sibling .ts, but the negation rule is the
  // governing reason).
  if (isNegationRulePath(path)) {
    return {
      path,
      hasSiblingTs,
      classification: 'preserved',
      preserveReason: 'negation-rule',
    };
  }

  // Req 8.4: a hand-authored .js/.d.ts with no sibling .ts is preserved.
  if (!hasSiblingTs) {
    return {
      path,
      hasSiblingTs,
      classification: 'preserved',
      preserveReason: 'no-sibling-ts',
    };
  }

  // Req 8.1: sibling .ts present and not in a preserved path => generated.
  return {
    path,
    hasSiblingTs,
    classification: 'generated',
  };
}

/**
 * Classify using a predicate that reports whether a given sibling `.ts` path
 * exists. The predicate is only consulted for genuine candidates.
 */
export function classifyWithChecker(
  file: string,
  siblingTsExists: (siblingTsPath: string) => boolean
): ArtifactClassification {
  const siblingTs = siblingTsPathFor(file);
  const hasSiblingTs = siblingTs !== null && siblingTsExists(siblingTs);
  return classify(file, hasSiblingTs);
}

/**
 * Classify using a set of known repository paths (e.g. the tracked file list).
 * The sibling `.ts` is considered present iff its path is a member of the set.
 * Paths are normalized before comparison.
 */
export function classifyWithSiblingSet(
  file: string,
  knownPaths: Set<string>
): ArtifactClassification {
  const normalized = new Set<string>();
  for (const p of knownPaths) normalized.add(normalize(p));
  return classifyWithChecker(file, (siblingTsPath) =>
    normalized.has(normalize(siblingTsPath))
  );
}

/**
 * Filesystem-backed variant: resolves the sibling `.ts` against the real
 * filesystem. `baseDir`, when supplied, is prepended to relative paths before
 * the existence check (e.g. the repository root); the returned classification
 * keeps the original (relative) `path`.
 */
export function classifyFromFilesystem(
  file: string,
  baseDir?: string
): ArtifactClassification {
  return classifyWithChecker(file, (siblingTsPath) => {
    const resolved =
      baseDir && !siblingTsPath.startsWith('/')
        ? `${normalize(baseDir).replace(/\/$/, '')}/${siblingTsPath}`
        : siblingTsPath;
    try {
      return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    } catch {
      return false;
    }
  });
}
