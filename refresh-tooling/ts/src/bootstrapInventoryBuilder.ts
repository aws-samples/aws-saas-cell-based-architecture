/**
 * Bootstrap Inventory Builder (Design Component for CC13 — Bootstrap template currency).
 *
 * Produces a {@link BootstrapElement}[] enumerating every version-bearing element
 * across the two workshop bootstrap CloudFormation templates:
 *   - `static/cfn/vscode-server.yaml`
 *   - `static/cfn/WorkshopStack.yaml`
 *
 * The inventory covers (Req 17.1):
 *   - each inline Lambda `Runtime` value,
 *   - the SSM document `NodeVersion` parameter (default + allowed values),
 *   - the SSM document `DotNetVersion` parameter (default + allowed values),
 *   - the pinned `code-server` install version,
 *   - the EC2 `InstanceType` default,
 *   - the `InstanceOperatingSystem` default + allowed values and their resolved
 *     AMI SSM parameters,
 *   - the CodeBuild `Image`.
 *
 * For every element the builder records: `file`, `location`, `currentValue`
 * (read from the actual template text), `targetValue` (per the design Target
 * Version Matrix "Workshop bootstrap template toolchain" table), the `dynamic`
 * flag, the `status`, and an optional `constraintNote`.
 *
 * Status derivation (Req 17.2, 17.8):
 *   - a `dynamic` element (e.g. an AMI "latest" public SSM parameter that
 *     self-resolves at deploy time) is always `'no-change-required'`,
 *   - otherwise `'retained'` when the current value already equals the target,
 *   - otherwise `'updated'`.
 *
 * The core {@link buildBootstrapInventory} is a PURE function over the parsed
 * template text, so it is testable without touching the filesystem. The
 * filesystem-backed {@link buildBootstrapInventoryFromFiles} reads the two YAMLs
 * from the workshop repository and delegates to the pure builder.
 *
 * This task (17.1) only BUILDS the inventory. Applying the edits is tasks
 * 17.2 / 17.3.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BootstrapElement } from './models';

/** Relative paths (from the workshop repository root) of the two bootstrap templates. */
export const VSCODE_SERVER_RELATIVE_PATH = 'static/cfn/vscode-server.yaml';
export const BOOTSTRAP_WORKSHOP_STACK_PATH = 'static/cfn/WorkshopStack.yaml';

/** Display `file` values recorded on every {@link BootstrapElement}. */
export const VSCODE_SERVER_FILE = VSCODE_SERVER_RELATIVE_PATH;
export const WORKSHOP_STACK_FILE = BOOTSTRAP_WORKSHOP_STACK_PATH;

/** Raw text of the two bootstrap templates — the input to the pure builder. */
export interface BootstrapTemplateContents {
  /** Raw text of `static/cfn/vscode-server.yaml`. */
  vscodeServer: string;
  /** Raw text of `static/cfn/WorkshopStack.yaml`. */
  workshopStack: string;
}

// ---------------------------------------------------------------------------
// Text extraction helpers (pure; operate on the raw template text)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Indentation width (number of leading spaces) of a line. */
function indentOf(line: string): number {
  return line.length - line.replace(/^ */, '').length;
}

/**
 * Slice the block of lines belonging to a `key:` mapping entry: the matched line
 * plus every following line indented strictly deeper than the key. Returns `null`
 * when the key is absent.
 */
function sliceBlock(content: string, key: string): string | null {
  const re = new RegExp(`(^|\\n)( *)${escapeRegExp(key)}:`);
  const m = re.exec(content);
  if (!m) {
    return null;
  }
  const keyIndent = m[2].length;
  const startLineIdx = m.index + m[1].length;
  const lines = content.slice(startLineIdx).split('\n');
  const out: string[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= keyIndent) {
      break;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Slice the block belonging to a top-level (2-space indented) CloudFormation
 * resource logical id, e.g. `SecretPlaintextLambda`.
 */
function sliceResourceBlock(content: string, logicalId: string): string | null {
  const re = new RegExp(`\\n  ${escapeRegExp(logicalId)}:`);
  const m = re.exec(content);
  if (!m) {
    return null;
  }
  const lines = content.slice(m.index + 1).split('\n');
  const out: string[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) {
      break;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** Extract the `Runtime:` value declared inside a named Lambda resource block. */
function extractResourceRuntime(content: string, logicalId: string): string | null {
  const block = sliceResourceBlock(content, logicalId);
  if (!block) {
    return null;
  }
  const m = /\n\s*Runtime:\s*([^\s#]+)/.exec(block);
  return m ? m[1] : null;
}

/** Extract the `default:`/`Default:` scalar declared inside a block. */
function extractDefault(block: string): string | null {
  const m = /(?:^|\n)\s*default:\s*'?([^'\n#]+?)'?\s*(?:#.*)?$/im.exec(block);
  return m ? m[1].trim() : null;
}

/**
 * Extract the allowed-values list declared inside a block, normalized to a stable
 * JSON-array string of quoted entries (so equality comparison is reliable).
 * Handles both the inline `AllowedValues: ['a', 'b']` form and the block
 * `allowedValues:\n  - 'a'\n  - 'b'` form.
 */
function extractAllowedList(block: string): string | null {
  const inline = /[Aa]llowed[Vv]alues:\s*\[([^\]]*)\]/.exec(block);
  if (inline) {
    const items = inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
    return normalizeList(items);
  }
  const listHeader = /(^|\n)(\s*)[Aa]llowed[Vv]alues:\s*(?:#.*)?\n/.exec(block);
  if (listHeader) {
    const headerIndent = listHeader[2].length;
    const rest = block.slice(listHeader.index + listHeader[1].length).split('\n').slice(1);
    const items: string[] = [];
    for (const line of rest) {
      if (line.trim() === '') {
        continue;
      }
      if (indentOf(line) <= headerIndent) {
        break;
      }
      const item = /^\s*-\s*'?([^'\n#]+?)'?\s*(?:#.*)?$/.exec(line);
      if (item) {
        items.push(item[1].trim());
      } else {
        break;
      }
    }
    if (items.length > 0) {
      return normalizeList(items);
    }
  }
  return null;
}

/** Normalize a list of string entries to a canonical `["a","b"]` representation. */
export function normalizeList(items: string[]): string {
  return JSON.stringify(items);
}

/** Extract the pinned `code-server` install version (`install.sh ... --version X`). */
function extractCodeServerVersion(content: string): string | null {
  const m = /code-server\.dev\/install\.sh[^\n]*--version\s+([^\s#]+)/.exec(content);
  return m ? m[1] : null;
}

/** Extract the EC2 `InstanceType` parameter default. */
function extractInstanceTypeDefault(content: string): string | null {
  const block = sliceBlock(content, 'InstanceType');
  return block ? extractDefault(block) : null;
}

/** Extract a single AMI `ImageId` SSM resolve string from a `Mappings` sub-entry. */
function extractAmiImageId(content: string, mapping: string, osKey: string): string | null {
  const mapBlock = sliceBlock(content, mapping);
  if (!mapBlock) {
    return null;
  }
  const osBlock = sliceBlock(mapBlock, osKey);
  if (!osBlock) {
    return null;
  }
  const m = /ImageId:\s*'([^']+)'/.exec(osBlock);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Element descriptors (Target Version Matrix, design CC13)
// ---------------------------------------------------------------------------

/**
 * A declarative descriptor for one version-bearing element: where it lives, how to
 * read its current value from the template text, its target value, and whether it
 * resolves dynamically. `status` is derived; it is not part of the descriptor.
 */
interface ElementDescriptor {
  file: string;
  location: string;
  /** Reads the current value from the appropriate template content. */
  extract: (c: BootstrapTemplateContents) => string | null;
  /** Target per the design Target Version Matrix. */
  targetValue: string;
  dynamic: boolean;
  constraintNote?: string;
}

/** Fallback marker used when the current value cannot be located in the template. */
export const NOT_FOUND = '<not-found>';

const DESCRIPTORS: ElementDescriptor[] = [
  // --- vscode-server.yaml: inline Lambda runtimes (Req 17.3) ---
  {
    file: VSCODE_SERVER_FILE,
    location: 'Resources.SecretPlaintextLambda.Properties.Runtime',
    extract: (c) => extractResourceRuntime(c.vscodeServer, 'SecretPlaintextLambda'),
    targetValue: 'python3.13',
    dynamic: false,
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'Resources.RunSSMDocLambda.Properties.Runtime',
    extract: (c) => extractResourceRuntime(c.vscodeServer, 'RunSSMDocLambda'),
    targetValue: 'python3.13',
    dynamic: false,
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'Resources.VSCodeHealthCheckLambda.Properties.Runtime',
    extract: (c) => extractResourceRuntime(c.vscodeServer, 'VSCodeHealthCheckLambda'),
    targetValue: 'python3.13',
    dynamic: false,
  },

  // --- vscode-server.yaml: SSM document NodeVersion (Req 17.4) ---
  {
    file: VSCODE_SERVER_FILE,
    location: 'SSM document parameter NodeVersion.default',
    extract: (c) => {
      const b = sliceBlock(c.vscodeServer, 'NodeVersion');
      return b ? extractDefault(b) : null;
    },
    targetValue: '22',
    dynamic: false,
    constraintNote: 'Retain — within the declared engines range (>=22) (Req 17.4).',
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'SSM document parameter NodeVersion.allowedValues',
    extract: (c) => {
      const b = sliceBlock(c.vscodeServer, 'NodeVersion');
      return b ? extractAllowedList(b) : null;
    },
    targetValue: normalizeList(['24', '22']),
    dynamic: false,
    constraintNote: 'Remove EOL majors 18 and 20 (Node 20 EOL ~Apr 2026); add 24 LTS (Req 17.4).',
  },

  // --- vscode-server.yaml: SSM document DotNetVersion (Req 17.5) ---
  {
    file: VSCODE_SERVER_FILE,
    location: 'SSM document parameter DotNetVersion.default',
    extract: (c) => {
      const b = sliceBlock(c.vscodeServer, 'DotNetVersion');
      return b ? extractDefault(b) : null;
    },
    targetValue: '10.0',
    dynamic: false,
    constraintNote: '.NET 10 is the current LTS (GA Nov 2025, supported to Nov 2028) (Req 17.5).',
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'SSM document parameter DotNetVersion.allowedValues',
    extract: (c) => {
      const b = sliceBlock(c.vscodeServer, 'DotNetVersion');
      return b ? extractAllowedList(b) : null;
    },
    targetValue: normalizeList(['10.0', '8.0']),
    dynamic: false,
    constraintNote: 'Remove EOL 7.0; keep 8.0 (LTS, supported to Nov 2026) (Req 17.5).',
  },

  // --- vscode-server.yaml: code-server pinned install (Req 17.6) ---
  {
    file: VSCODE_SERVER_FILE,
    location: 'Resources VSCodeInstanceSSMDoc install code-server --version',
    extract: (c) => extractCodeServerVersion(c.vscodeServer),
    targetValue: '4.105.1',
    dynamic: false,
    constraintNote:
      '[confirm-at-exec] Latest stable code-server release observed (v4.105.1); confirm newest at execution (Req 17.6).',
  },

  // --- vscode-server.yaml: EC2 InstanceType default (Req 17.9) ---
  {
    file: VSCODE_SERVER_FILE,
    location: 'Parameters.InstanceType.Default',
    extract: (c) => extractInstanceTypeDefault(c.vscodeServer),
    targetValue: 't4g.medium',
    dynamic: false,
    constraintNote:
      'Retain — current Graviton general-purpose; arch matches the Graviton AMI mapping (Req 17.9).',
  },

  // --- vscode-server.yaml: InstanceOperatingSystem default + allowed (Req 17.1, 17.9) ---
  {
    file: VSCODE_SERVER_FILE,
    location: 'Parameters.InstanceOperatingSystem.Default',
    extract: (c) => {
      const b = sliceBlock(c.vscodeServer, 'InstanceOperatingSystem');
      return b ? extractDefault(b) : null;
    },
    targetValue: 'AmazonLinux-2023',
    dynamic: false,
    constraintNote: 'Retain — AL2023 default is the current LTS (Req 17.9).',
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'Parameters.InstanceOperatingSystem.AllowedValues',
    extract: (c) => {
      const b = sliceBlock(c.vscodeServer, 'InstanceOperatingSystem');
      return b ? extractAllowedList(b) : null;
    },
    // Retain current allowed list: both Ubuntu-22 and Ubuntu-24 remain supported,
    // so retention is acceptable; the trim decision is recorded for maintainer review.
    targetValue: normalizeList(['AmazonLinux-2023', 'Ubuntu-22', 'Ubuntu-24']),
    dynamic: false,
    constraintNote:
      '[confirm] Ubuntu-22 may be dropped in favor of Ubuntu-24; both remain supported so retention is acceptable — record decision (Req 17.1, 17.9).',
  },

  // --- vscode-server.yaml: AMI SSM parameters (dynamic, Req 17.8) ---
  {
    file: VSCODE_SERVER_FILE,
    location: 'Mappings.ArmImage.AmazonLinux-2023.ImageId',
    extract: (c) => extractAmiImageId(c.vscodeServer, 'ArmImage', 'AmazonLinux-2023'),
    targetValue: '',
    dynamic: true,
    constraintNote:
      'Public "latest" SSM parameter self-resolves to a supported AMI; no static change required (Req 17.8).',
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'Mappings.ArmImage.Ubuntu-22.ImageId',
    extract: (c) => extractAmiImageId(c.vscodeServer, 'ArmImage', 'Ubuntu-22'),
    targetValue: '',
    dynamic: true,
    constraintNote:
      'Public "latest" SSM parameter self-resolves to a supported AMI; no static change required (Req 17.8).',
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'Mappings.ArmImage.Ubuntu-24.ImageId',
    extract: (c) => extractAmiImageId(c.vscodeServer, 'ArmImage', 'Ubuntu-24'),
    targetValue: '',
    dynamic: true,
    constraintNote:
      'Public "latest" SSM parameter self-resolves to a supported AMI; no static change required (Req 17.8).',
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'Mappings.AmdImage.AmazonLinux-2023.ImageId',
    extract: (c) => extractAmiImageId(c.vscodeServer, 'AmdImage', 'AmazonLinux-2023'),
    targetValue: '',
    dynamic: true,
    constraintNote:
      'Public "latest" SSM parameter self-resolves to a supported AMI; no static change required (Req 17.8).',
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'Mappings.AmdImage.Ubuntu-22.ImageId',
    extract: (c) => extractAmiImageId(c.vscodeServer, 'AmdImage', 'Ubuntu-22'),
    targetValue: '',
    dynamic: true,
    constraintNote:
      'Public "latest" SSM parameter self-resolves to a supported AMI; no static change required (Req 17.8).',
  },
  {
    file: VSCODE_SERVER_FILE,
    location: 'Mappings.AmdImage.Ubuntu-24.ImageId',
    extract: (c) => extractAmiImageId(c.vscodeServer, 'AmdImage', 'Ubuntu-24'),
    targetValue: '',
    dynamic: true,
    constraintNote:
      'Public "latest" SSM parameter self-resolves to a supported AMI; no static change required (Req 17.8).',
  },

  // --- WorkshopStack.yaml: inline Lambda runtime (Req 17.3) ---
  {
    file: WORKSHOP_STACK_FILE,
    location: 'Resources.TriggerCodeBuild.Properties.Runtime',
    extract: (c) => extractResourceRuntime(c.workshopStack, 'TriggerCodeBuild'),
    targetValue: 'python3.13',
    dynamic: false,
    constraintNote: 'Match repo Python baseline 3.13, non-deprecated (Req 17.3).',
  },

  // --- WorkshopStack.yaml: CodeBuild Image (Req 17.7) ---
  {
    file: WORKSHOP_STACK_FILE,
    location: 'Resources.InstallWorkshopStack.Properties.Environment.Image',
    extract: (c) => {
      const m = /\n\s*Image:\s*([^\s#]+)/.exec(c.workshopStack);
      return m ? m[1] : null;
    },
    targetValue: 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
    dynamic: false,
    constraintNote:
      '[confirm-at-exec] Move to the AL2023-based standard image (latest standard 5.0); confirm the newest standard tag at execution (Req 17.7).',
  },
];

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Derive an element's status from its dynamic flag and current/target values.
 *
 *   - dynamic                -> 'no-change-required' (Req 17.8)
 *   - current === target     -> 'retained'
 *   - otherwise              -> 'updated'
 */
export function deriveStatus(
  dynamic: boolean,
  currentValue: string,
  targetValue: string
): BootstrapElement['status'] {
  if (dynamic) {
    return 'no-change-required';
  }
  return currentValue === targetValue ? 'retained' : 'updated';
}

/**
 * Pure builder: produce the bootstrap inventory from the raw template text.
 *
 * Reads each element's actual current value from the supplied template content
 * (Req 17.1). For a `dynamic` element the recorded `targetValue` mirrors the
 * current value (it is left unchanged) and the status is `'no-change-required'`.
 */
export function buildBootstrapInventory(
  contents: BootstrapTemplateContents
): BootstrapElement[] {
  return DESCRIPTORS.map((d) => {
    const extracted = d.extract(contents);
    const currentValue = extracted ?? NOT_FOUND;
    // A dynamic element is left unchanged: its target is its current value.
    const targetValue = d.dynamic ? currentValue : d.targetValue;
    const status = deriveStatus(d.dynamic, currentValue, targetValue);

    const element: BootstrapElement = {
      file: d.file,
      location: d.location,
      currentValue,
      targetValue,
      dynamic: d.dynamic,
      status,
    };

    const notes: string[] = [];
    if (d.constraintNote) {
      notes.push(d.constraintNote);
    }
    if (extracted === null) {
      notes.push(
        'Current value could not be located in the template text; recorded as not-found for maintainer review.'
      );
    }
    if (notes.length > 0) {
      element.constraintNote = notes.join(' ');
    }
    return element;
  });
}

/** Read the two bootstrap templates from the workshop repository root. */
export function readBootstrapTemplates(workshopRoot: string): BootstrapTemplateContents {
  return {
    vscodeServer: fs.readFileSync(
      path.resolve(workshopRoot, VSCODE_SERVER_RELATIVE_PATH),
      'utf8'
    ),
    workshopStack: fs.readFileSync(
      path.resolve(workshopRoot, BOOTSTRAP_WORKSHOP_STACK_PATH),
      'utf8'
    ),
  };
}

/**
 * Filesystem-backed builder: read the two YAMLs from `workshopRoot` and build the
 * inventory over their actual content.
 */
export function buildBootstrapInventoryFromFiles(workshopRoot: string): BootstrapElement[] {
  return buildBootstrapInventory(readBootstrapTemplates(workshopRoot));
}
