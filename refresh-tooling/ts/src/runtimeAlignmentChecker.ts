/**
 * Runtime Alignment Checker (Design Component 4, CC4).
 *
 * Confirms that every runtime-bearing surface references the SAME Python
 * major.minor version:
 *   - the Lambda Python runtime (`LambdaFunctionConstruct.ts`, e.g. `PYTHON_3_13`),
 *   - the Flask container base image (`dockerfile`, e.g. `python:3.13-slim`),
 *   - the bootstrap inline-Lambda runtimes (CloudFormation, e.g. `python3.13`).
 *
 * Behavior (Requirements 4.1, 4.3, 4.4, 17.3):
 *   - 4.1: the Flask base image Python major.minor equals the Lambda runtime
 *     Python major.minor.
 *   - 4.3: on completion the checker confirms the Lambda runtime and Flask base
 *     image reference the same Python major.minor.
 *   - 17.3: each inline Lambda `Runtime` in the bootstrap templates uses a Python
 *     runtime whose major.minor equals the repository Python baseline (the Lambda
 *     runtime), so it must also align.
 *   - 4.4: a mismatch halts the refresh leaving prior config unchanged; here this
 *     surfaces as `aligned === false` with a populated `mismatches[]` enumerating
 *     the offending surface(s).
 *
 * The checker is a pure function over the extracted runtime-bearing values so it is
 * testable without touching the filesystem. {@link checkAlignment} normalizes each
 * surface to a `<major>.<minor>` string, then reports `aligned === true` iff every
 * surface parses and all equal the Lambda baseline.
 *
 * Interface (design): `checkAlignment() -> AlignmentReport`.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AlignmentReport } from './models';

/** Raw runtime-bearing values gathered from the three surfaces. */
export interface AlignmentInput {
  /** Lambda runtime token, e.g. "PYTHON_3_13", "python3.13", or "3.13". */
  lambdaRuntime: string;
  /** Flask base image, e.g. "public.ecr.aws/docker/library/python:3.13-slim" or "3.13". */
  flaskBaseImage: string;
  /** Bootstrap inline-Lambda runtimes, e.g. ["python3.13", ...]. */
  bootstrapRuntimes: string[];
}

/**
 * Extract a `<major>.<minor>` Python version string from an arbitrary runtime
 * token. Accepts the common encodings used across the surfaces:
 *   "PYTHON_3_13"            -> "3.13"
 *   "python3.13"             -> "3.13"
 *   "python:3.13-slim"       -> "3.13"
 *   "3.13"                   -> "3.13"
 * Returns `null` when no major.minor pair can be located.
 */
export function extractMajorMinor(raw: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const m = /(\d+)[._](\d+)/.exec(raw);
  if (!m) {
    return null;
  }
  return `${Number(m[1])}.${Number(m[2])}`;
}

/**
 * Check runtime alignment across the Lambda runtime, Flask base image, and the
 * bootstrap inline-Lambda runtimes.
 *
 * The Lambda runtime is the baseline (Req 17.3 anchors every bootstrap runtime to
 * the repository Python baseline). `aligned` is `true` iff the Lambda runtime, the
 * Flask base image, and every bootstrap runtime parse to a major.minor and all of
 * them equal the Lambda baseline. Otherwise `aligned` is `false` and `mismatches`
 * enumerates each offending surface (Req 4.4).
 */
export function checkAlignment(input: AlignmentInput): AlignmentReport {
  const lambdaPython = extractMajorMinor(input.lambdaRuntime) ?? '';
  const flaskBaseImage = extractMajorMinor(input.flaskBaseImage) ?? '';
  const bootstrapRuntimes = [...input.bootstrapRuntimes];

  const mismatches: string[] = [];

  // The Lambda runtime is the baseline; an unparseable baseline is itself a mismatch.
  if (lambdaPython === '') {
    mismatches.push(
      `Lambda runtime "${input.lambdaRuntime}" does not encode a Python major.minor version`
    );
  }

  // Flask base image must equal the Lambda baseline (Req 4.1, 4.3).
  if (flaskBaseImage === '') {
    mismatches.push(
      `Flask base image "${input.flaskBaseImage}" does not encode a Python major.minor version`
    );
  } else if (lambdaPython !== '' && flaskBaseImage !== lambdaPython) {
    mismatches.push(
      `Flask base image Python ${flaskBaseImage} != Lambda runtime Python ${lambdaPython}`
    );
  }

  // Every bootstrap inline-Lambda runtime must equal the Lambda baseline (Req 17.3).
  bootstrapRuntimes.forEach((rt, i) => {
    const v = extractMajorMinor(rt);
    if (v === null) {
      mismatches.push(
        `Bootstrap runtime[${i}] "${rt}" does not encode a Python major.minor version`
      );
    } else if (lambdaPython !== '' && v !== lambdaPython) {
      mismatches.push(
        `Bootstrap runtime[${i}] Python ${v} != Lambda runtime Python ${lambdaPython}`
      );
    }
  });

  return {
    lambdaPython,
    flaskBaseImage,
    bootstrapRuntimes,
    aligned: mismatches.length === 0,
    mismatches,
  };
}

/** Repository-relative path to a construct declaring the Lambda Python runtime. */
export const LAMBDA_CONSTRUCT_RELATIVE_PATH =
  'lib/application-plane/cell-app-plane/cdk/lib/LambdaFunctionConstruct.ts';

/** Repository-relative path to the Flask container Dockerfile (set by Task 5.1). */
export const DOCKERFILE_RELATIVE_PATH =
  'lib/application-plane/cell-app-plane/src/resources/dockerfile';

/**
 * Fail-safe guard implementing the Req 4.4 halt contract. Returns the report when
 * it is aligned; throws otherwise so the caller halts the refresh and leaves the
 * prior configuration unchanged. The thrown message enumerates every mismatch.
 */
export function assertAligned(report: AlignmentReport): AlignmentReport {
  if (!report.aligned) {
    throw new Error(
      `Runtime alignment check failed; refresh halted with prior configuration ` +
        `retained (Req 4.4):\n - ${report.mismatches.join('\n - ')}`
    );
  }
  return report;
}

/**
 * Read the Lambda Python runtime major.minor from the repository construct source
 * (sources the actual `Runtime.PYTHON_x_y` value rather than assuming it). Returns
 * `null` when the file cannot be read or no runtime reference is found, so callers
 * can fall back to an explicit input — mirroring {@link loadAuroraEnumMembers}.
 */
export function loadLambdaPythonVersion(
  repoRoot = path.resolve(__dirname, '../../..'),
  relativePath = LAMBDA_CONSTRUCT_RELATIVE_PATH
): string | null {
  try {
    const source = fs.readFileSync(path.resolve(repoRoot, relativePath), 'utf8');
    return extractMajorMinor(source);
  } catch {
    return null;
  }
}

/**
 * Read the Flask container base-image Python major.minor from the repository
 * Dockerfile (sources the actual `python:x.y-slim` value). Returns `null` when the
 * file cannot be read or no image reference is found, so callers can fall back to
 * an explicit input.
 */
export function loadFlaskBaseImageVersion(
  repoRoot = path.resolve(__dirname, '../../..'),
  relativePath = DOCKERFILE_RELATIVE_PATH
): string | null {
  try {
    const source = fs.readFileSync(path.resolve(repoRoot, relativePath), 'utf8');
    const imageMatch = /python:(\d+)\.(\d+)/i.exec(source);
    if (!imageMatch) return null;
    return `${imageMatch[1]}.${imageMatch[2]}`;
  } catch {
    return null;
  }
}
