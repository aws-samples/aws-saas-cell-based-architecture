/**
 * Construct-API Remediator — inventory builder (Design Component 3).
 *
 * Builds a {@link CompatInventory} from the `tsc` + `cdk synth` output produced
 * under the target `aws-cdk-lib`. Each entry records the source file, the affected
 * construct/API, the associated message, and the kind of finding
 * (`deprecation` | `error` | `removed`), per Requirement 7.1.
 *
 * This module is the *inventory* half of the Construct-API Remediator
 * (`inventory() -> CompatInventory`). The *remediate* half (task 4.2) consumes the
 * inventory this module produces.
 *
 * The parser is intentionally pure: it turns raw tool output text into structured
 * entries so it can be unit tested without invoking the toolchain. A thin
 * orchestration layer (the generator script) captures the real `tsc`/`cdk synth`
 * output and feeds it here.
 *
 * Scope note (Req 7.1): the inventory records *construct-API compatibility* findings
 * — TypeScript deprecation/removed-API messages, compilation errors, and the
 * `[WARNING] ... is deprecated` messages emitted by `cdk synth` under the target
 * library. `cdk-nag` findings (e.g. `AwsSolutions-COG8`) are a separate concern
 * handled as NagDispositions (task 4.4) and are deliberately NOT included here.
 *
 * Feature: codebase-modernization-refresh
 */
import type { CompatInventoryEntry } from './models';

/** An ordered list of construct-API compatibility findings (Req 7.1). */
export type CompatInventory = CompatInventoryEntry[];

/** A source file presented to the file-attribution step. */
export interface SourceFile {
  /** repository-relative path */
  path: string;
  /** full text content */
  content: string;
}

/**
 * Parse TypeScript compiler diagnostics from `tsc` output.
 *
 * Recognizes the canonical `tsc` error format:
 *   `relative/path/File.ts(line,col): error TS1234: message`
 *
 * Classification (Req 7.1):
 * - a diagnostic whose message mentions "deprecated" → `deprecation`
 * - a diagnostic indicating a property/member no longer exists → `removed`
 * - any other compile error → `error`
 */
export function parseTscOutput(output: string): CompatInventoryEntry[] {
  const entries: CompatInventoryEntry[] = [];
  const lineRe = /^(.+?\.ts)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

  for (const rawLine of output.split(/\r?\n/)) {
    const m = lineRe.exec(rawLine.trim());
    if (!m) {
      continue;
    }
    const [, file, line, , code, message] = m;
    const fullMessage = `${code}: ${message}`;
    let kind: CompatInventoryEntry['kind'] = 'error';
    if (/deprecated/i.test(message)) {
      kind = 'deprecation';
    } else if (
      /does not exist|has been removed|is not assignable|no longer/i.test(message)
    ) {
      kind = 'removed';
    }
    entries.push({
      file,
      construct: extractConstructFromTsMessage(message),
      message: `${fullMessage} (at line ${line})`,
      kind,
    });
  }
  return entries;
}

/**
 * Best-effort extraction of the offending symbol from a `tsc` message. TypeScript
 * quotes identifiers with single quotes (e.g. `Property 'logRetention' does not
 * exist...`). Returns the first quoted identifier, or an empty string.
 */
function extractConstructFromTsMessage(message: string): string {
  const q = /'([^']+)'/.exec(message);
  return q ? q[1] : '';
}

/**
 * Parse construct-API deprecation warnings emitted by `cdk synth` under the target
 * `aws-cdk-lib`. The CDK warning block has the shape:
 *
 *   [WARNING] aws-cdk-lib.aws_dynamodb.TableOptions#pointInTimeRecovery is deprecated.
 *     use `pointInTimeRecoverySpecification` instead
 *     This API will be removed in the next major release.
 *
 * The leading `[WARNING] <construct> is deprecated.` line identifies the construct;
 * subsequent indented continuation lines carry the guidance and removal notice. The
 * `use X instead` continuation becomes the entry's `resolution`.
 *
 * `cdk-nag` findings (`[Warning at /...]`, `[Error at /...] AwsSolutions-...`) are
 * NOT construct-API compatibility findings and are intentionally ignored here.
 */
export function parseDeprecationWarnings(output: string): CompatInventoryEntry[] {
  const entries: CompatInventoryEntry[] = [];
  const lines = output.split(/\r?\n/);
  const headerRe = /^\[WARNING\]\s+(.+?)\s+is deprecated\.?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const header = headerRe.exec(lines[i].trim());
    if (!header) {
      continue;
    }
    const construct = header[1];
    const continuation: string[] = [];
    // Collect indented continuation lines that belong to this warning block.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (/^\s+\S/.test(next) && !headerRe.test(next.trim())) {
        continuation.push(next.trim());
      } else {
        break;
      }
    }
    const resolution = extractResolution(continuation);
    const message = ['is deprecated', ...continuation].join('. ').replace(/\.\./g, '.');
    entries.push({
      file: '',
      construct,
      message,
      kind: 'deprecation',
      ...(resolution ? { resolution } : {}),
    });
  }
  return entries;
}

/** Pull the `use X instead` guidance out of the continuation lines. */
function extractResolution(continuation: string[]): string | undefined {
  for (const c of continuation) {
    const m = /use\s+`?([^`]+?)`?\s+instead/i.exec(c);
    if (m) {
      return `use ${m[1]} instead`;
    }
  }
  return undefined;
}

/**
 * Attribute each (file-less) deprecation entry to the repository source file(s) that
 * use the deprecated member, by searching the provided source files for the member
 * name (the token after the final `#` or `.` in the construct identifier).
 *
 * One matching source file yields one entry. When a deprecated member is used in
 * several files, the single inbound entry is expanded into one entry per file so the
 * remediation step (task 4.2) has a complete worklist. Entries that already carry a
 * concrete `file` (e.g. `tsc` diagnostics) are passed through unchanged. Entries
 * whose member cannot be located keep an empty `file` and are passed through so the
 * unresolved finding is still recorded.
 */
export function attributeFiles(
  entries: CompatInventoryEntry[],
  files: SourceFile[]
): CompatInventoryEntry[] {
  const result: CompatInventoryEntry[] = [];

  for (const entry of entries) {
    if (entry.file) {
      result.push(entry);
      continue;
    }
    const member = memberToken(entry.construct);
    if (!member) {
      result.push(entry);
      continue;
    }
    const memberRe = new RegExp(`\\b${escapeRegExp(member)}\\b`);
    const matches = files.filter((f) => memberRe.test(f.content));
    if (matches.length === 0) {
      result.push(entry);
      continue;
    }
    for (const match of matches) {
      result.push({ ...entry, file: match.path });
    }
  }
  return result;
}

/** Extract the member identifier from `aws-cdk-lib.aws_x.Type#member` or `...Type.member`. */
function memberToken(construct: string): string {
  if (!construct) {
    return '';
  }
  const hash = construct.lastIndexOf('#');
  if (hash >= 0) {
    return construct.slice(hash + 1).trim();
  }
  const parts = construct.split('.');
  return parts[parts.length - 1].trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a {@link CompatInventory} from one app's `tsc` and `cdk synth` output,
 * optionally attributing deprecation warnings to repository source files.
 *
 * This is the pure core of the Construct-API Remediator's `inventory()` interface
 * (Design Component 3): given the raw tool output captured under the target
 * `aws-cdk-lib`, it returns the structured compatibility inventory.
 */
export function buildCompatInventory(input: {
  tscOutput?: string;
  synthOutput?: string;
  sourceFiles?: SourceFile[];
}): CompatInventory {
  const tscEntries = input.tscOutput ? parseTscOutput(input.tscOutput) : [];
  const synthEntries = input.synthOutput
    ? parseDeprecationWarnings(input.synthOutput)
    : [];
  const combined = [...tscEntries, ...synthEntries];
  return input.sourceFiles ? attributeFiles(combined, input.sourceFiles) : combined;
}
