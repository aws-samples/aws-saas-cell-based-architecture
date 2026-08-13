/**
 * Unit tests for the Construct-API Remediator inventory builder (Design Component 3).
 *
 * Validates that real `tsc` + `cdk synth` output is parsed into correct
 * {@link CompatInventoryEntry} records (file, construct, message, kind) per Req 7.1,
 * and that deprecation warnings are attributed to the repository source files that
 * use the deprecated member.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  parseTscOutput,
  parseDeprecationWarnings,
  attributeFiles,
  buildCompatInventory,
  SourceFile,
} from './constructApiRemediator';

// The exact deprecation block emitted by `cdk synth` for the Control_Plane_App
// under aws-cdk-lib 2.260.0 (captured during task 4.1 execution).
const CONTROL_PLANE_SYNTH = `Bundling asset CellManagementSystem/AuthorizerLambda/lambdaFunction/Code/Stage...
[WARNING] aws-cdk-lib.aws_dynamodb.TableOptions#pointInTimeRecovery is deprecated.
  use \`pointInTimeRecoverySpecification\` instead
  This API will be removed in the next major release.
Bundling asset CellManagementSystem/CreateCellFunction/lambdaFunction/Code/Stage...
[WARNING] aws-cdk-lib.aws_lambda.FunctionOptions#logRetention is deprecated.
  use \`logGroup\` instead
  This API will be removed in the next major release.
[Warning at /CellManagementSystem] No cross-stack-reference strength configured, defaulting to "strong".
[Error at /CellManagementSystem/IdentityProvider/SystemAdminUserPool/Resource] AwsSolutions-COG8: The Cognito user pool is not on the plus tier / feature plan.
Found errors`;

describe('parseDeprecationWarnings', () => {
  it('extracts each construct-API deprecation warning from cdk synth output', () => {
    const entries = parseDeprecationWarnings(CONTROL_PLANE_SYNTH);
    expect(entries).toHaveLength(2);

    expect(entries[0]).toMatchObject({
      construct: 'aws-cdk-lib.aws_dynamodb.TableOptions#pointInTimeRecovery',
      kind: 'deprecation',
      resolution: 'use pointInTimeRecoverySpecification instead',
    });
    expect(entries[0].message).toContain('removed in the next major release');

    expect(entries[1]).toMatchObject({
      construct: 'aws-cdk-lib.aws_lambda.FunctionOptions#logRetention',
      kind: 'deprecation',
      resolution: 'use logGroup instead',
    });
  });

  it('ignores cdk-nag findings (they are NagDispositions, not construct-API findings)', () => {
    const entries = parseDeprecationWarnings(CONTROL_PLANE_SYNTH);
    const messages = entries.map((e) => e.construct).join(' ');
    expect(messages).not.toContain('AwsSolutions-COG8');
    expect(messages).not.toContain('cross-stack-reference');
  });

  it('returns an empty inventory when synth emits no deprecation warnings', () => {
    const clean = `Bundling asset Cell/Code/Stage...
[Warning at /Cell/TenantUserPool/Resource] AwsSolutions-COG2: requires MFA.
[Error at /Cell/TenantUserPool/Resource] AwsSolutions-COG8: not on the plus tier.
Found errors`;
    expect(parseDeprecationWarnings(clean)).toEqual([]);
  });
});

describe('parseTscOutput', () => {
  it('parses a compile error into an error entry', () => {
    const out = `lib/saas-management/foo.ts(48,27): error TS2554: Expected 2 arguments, but got 1.`;
    const entries = parseTscOutput(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      file: 'lib/saas-management/foo.ts',
      kind: 'error',
    });
    expect(entries[0].message).toContain('TS2554');
  });

  it('classifies a removed-member diagnostic as removed', () => {
    const out = `lib/x.ts(10,5): error TS2339: Property 'logRetention' does not exist on type 'FunctionProps'.`;
    const entries = parseTscOutput(out);
    expect(entries[0].kind).toBe('removed');
    expect(entries[0].construct).toBe('logRetention');
  });

  it('classifies a deprecation diagnostic as deprecation', () => {
    const out = `lib/x.ts(10,5): error TS6385: 'pointInTimeRecovery' is deprecated.`;
    const entries = parseTscOutput(out);
    expect(entries[0].kind).toBe('deprecation');
  });

  it('returns an empty inventory for clean tsc output', () => {
    expect(parseTscOutput('')).toEqual([]);
    expect(parseTscOutput('\n\n')).toEqual([]);
  });
});

describe('attributeFiles', () => {
  const sources: SourceFile[] = [
    {
      path: 'lib/saas-management/cell-management-system/cell-management-system-stack.ts',
      content: 'const t = new Table(this, "t", { pointInTimeRecovery: true });',
    },
    {
      path: 'lib/saas-management/cell-provisioning-system/app-plane-staggered-deployment-construct.ts',
      content: 'new Function(this, "f", { logRetention: logs.RetentionDays.ONE_DAY });',
    },
  ];

  it('attributes a deprecation warning to the source file that uses the member', () => {
    const [entry] = parseDeprecationWarnings(
      '[WARNING] aws-cdk-lib.aws_dynamodb.TableOptions#pointInTimeRecovery is deprecated.\n  use `pointInTimeRecoverySpecification` instead'
    );
    const attributed = attributeFiles([entry], sources);
    expect(attributed).toHaveLength(1);
    expect(attributed[0].file).toBe(
      'lib/saas-management/cell-management-system/cell-management-system-stack.ts'
    );
  });

  it('keeps an empty file when the member is used in no provided source', () => {
    const [entry] = parseDeprecationWarnings(
      '[WARNING] aws-cdk-lib.aws_x.Type#nonexistentMember is deprecated.'
    );
    const attributed = attributeFiles([entry], sources);
    expect(attributed).toHaveLength(1);
    expect(attributed[0].file).toBe('');
  });

  it('expands one entry per file when a member is used in multiple files', () => {
    const multi: SourceFile[] = [
      { path: 'a.ts', content: 'logRetention: 1' },
      { path: 'b.ts', content: 'logRetention: 7' },
    ];
    const [entry] = parseDeprecationWarnings(
      '[WARNING] aws-cdk-lib.aws_lambda.FunctionOptions#logRetention is deprecated.'
    );
    const attributed = attributeFiles([entry], multi);
    expect(attributed.map((e) => e.file).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('passes tsc entries (which already have a file) through unchanged', () => {
    const tsc = parseTscOutput('lib/x.ts(1,1): error TS1: boom.');
    const attributed = attributeFiles(tsc, sources);
    expect(attributed).toEqual(tsc);
  });
});

describe('buildCompatInventory', () => {
  it('combines synth deprecations with tsc errors and attributes files', () => {
    const inv = buildCompatInventory({
      tscOutput: 'lib/x.ts(1,1): error TS2554: boom.',
      synthOutput: CONTROL_PLANE_SYNTH,
      sourceFiles: [
        {
          path: 'lib/saas-management/cell-management-system/cell-management-system-stack.ts',
          content: 'pointInTimeRecovery: true',
        },
        {
          path: 'lib/saas-management/cell-provisioning-system/app-plane-staggered-deployment-construct.ts',
          content: 'logRetention: logs.RetentionDays.ONE_DAY',
        },
      ],
    });
    // 1 tsc error + 2 attributed deprecations
    expect(inv).toHaveLength(3);
    expect(inv.filter((e) => e.kind === 'deprecation')).toHaveLength(2);
    expect(inv.filter((e) => e.kind === 'error')).toHaveLength(1);
    expect(inv.every((e) => e.file !== '')).toBe(true);
  });

  it('produces an empty inventory when both outputs are clean (valid good result)', () => {
    expect(buildCompatInventory({ tscOutput: '', synthOutput: '' })).toEqual([]);
  });
});
