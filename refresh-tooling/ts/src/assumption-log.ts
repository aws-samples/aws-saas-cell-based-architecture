/**
 * Resolved assumption log for the codebase-modernization-refresh.
 *
 * Task 1.4 — Resolve every [confirm-at-exec] / [verify-enum] / [maintainer-confirm]
 * fast-moving target from the design's Target Version Matrix against the LIVE
 * npm / PyPI registries and the `aws-cdk-lib` `AuroraPostgresEngineVersion` enum,
 * and record the result as structured `SubstitutionRecord` / `EngineDecision`
 * planning entries.
 *
 * Resolution policy (Requirements 1.6, 5.2, 5.4, 17.11):
 *   - Each fast-moving target is resolved to the highest stable, non-deprecated
 *     release whose peer/compatibility constraints are satisfiable across both apps.
 *   - Where the registry value supersedes the design's documented target, the
 *     selected value is the live registry value and the substitution is recorded.
 *   - Where no compliant version exists, the current value is RETAINED and the
 *     constraint is recorded for maintainer review (never guessed).
 *
 * Resolution evidence (queried against live registries on 2026-06-22T02:35:25Z):
 *   - npm view aws-cdk-lib version            -> 2.260.0
 *   - npm view aws-cdk version                -> 2.1128.0
 *   - npm view constructs version             -> 10.6.0
 *   - npm view cdk-nag version                -> 3.0.1  (latest 2.x => 2.38.2)
 *   - npm view typescript@5 version           -> 5.9.3
 *   - npm view @types/node@^22 version        -> 22.20.0
 *   - npm view @aws-cdk/aws-lambda-python-alpha@2.260.0-alpha.0 -> exists
 *   - PyPI flask                              -> 3.1.3
 *   - PyPI boto3                              -> 1.43.34
 *   - PyPI psycopg                            -> 3.3.4
 *   - PyPI PyJWT                              -> 2.13.0
 *   - GitHub coder/code-server latest         -> v4.125.0
 *   - CodeBuild AL2023 standard (x86_64)       -> :6.0 (docs: ec2-compute-images)
 *   - aws-cdk-lib@2.260.0 AuroraPostgresEngineVersion enum contains VER_15_17
 *
 * Feature: codebase-modernization-refresh
 */

import {
  VersionSet,
  SubstitutionRecord,
  EngineDecision,
  BootstrapElement,
} from './models';

/** UTC timestamp at which the live registries/enum were queried for this log. */
export const RESOLVED_AT = '2026-06-22T02:35:25Z';

/**
 * The canonical, resolved CDK dependency set applied identically to both apps.
 * Alpha_Module is character-for-character `awsCdkLib` + the `-alpha.0` suffix
 * (Req 1.3) and was confirmed published. Exact-pin style is preserved for
 * `cdk-nag` and the Alpha_Module (Req 1.5); caret/tilde style is preserved for
 * `constructs`, `typescript`, and `@types/node`.
 */
export const resolvedVersionSet: VersionSet = {
  awsCdkLib: '2.260.0',
  awsCdkCli: '2.1128.0',
  alphaModule: '2.260.0-alpha.0',
  constructs: '^10.6.0',
  cdkNag: '2.38.2',
  typescript: '~5.9.3',
  typesNode: '^22.20.0',
  jest: '^29.7.0',
  tsJest: '^29.4.4',
  tsNode: '^10.9.2',
  nodeEngines: '>=22.0.0 <25.0.0',
  ecmaTarget: 'ES2023',
};

/**
 * One `SubstitutionRecord` per fast-moving target resolved at execution time.
 * `requestedVersion` is the design's documented target (with its marker);
 * `selectedVersion` is the value resolved from the live registry/enum.
 */
export const substitutions: SubstitutionRecord[] = [
  {
    dependency: 'aws-cdk-lib',
    requestedVersion: '2.258.0',
    selectedVersion: '2.260.0',
    reason:
      'Highest stable construct-library release on npm at resolution time ' +
      '(npm view aws-cdk-lib version => 2.260.0), superseding the design baseline ' +
      '2.258.0. Anchors the peer-constraint graph for both apps (Req 1.1).',
  },
  {
    dependency: 'aws-cdk (CLI)',
    requestedVersion: 'latest 2.10xx.x [confirm-at-exec]',
    selectedVersion: '2.1128.0',
    reason:
      'CLI versions independently from the library since Feb 2025; selected the ' +
      'latest published CLI (npm view aws-cdk version => 2.1128.0), which is ' +
      'compatible with aws-cdk-lib 2.260.0. Supersedes design note 2.1031.1 (Req 1.2).',
  },
  {
    dependency: '@aws-cdk/aws-lambda-python-alpha (Alpha_Module)',
    requestedVersion: '2.258.0-alpha.0',
    selectedVersion: '2.260.0-alpha.0',
    reason:
      'Pinned character-for-character to the selected aws-cdk-lib (2.260.0) per the ' +
      'alpha-suffix convention; confirmed published on npm. Exact-pin style preserved (Req 1.3, 1.5).',
  },
  {
    dependency: 'constructs',
    requestedVersion: '^10.4.2 [confirm-at-exec]',
    selectedVersion: '^10.6.0',
    reason:
      'Latest constructs 10.x (npm view constructs version => 10.6.0). Caret range ' +
      'preserved; satisfies aws-cdk-lib ^10 and cdk-nag 2.38.2 (constructs ^10.0.5) (Req 1.4).',
  },
  {
    dependency: 'cdk-nag',
    requestedVersion: 'latest 2.x [confirm-at-exec]',
    selectedVersion: '2.38.2',
    reason:
      'Selected the highest cdk-nag 2.x (2.38.2; peers aws-cdk-lib ^2.176.0, ' +
      'constructs ^10.0.5 — satisfied by 2.260.0). cdk-nag 3.0.1 is published and ' +
      'peer-compatible, but a major-version bump risks new/changed rule behavior ' +
      'against the behavior-preservation constraint (Req 16); deferred to maintainer ' +
      'review rather than adopted automatically. Exact-pin style preserved (Req 1.5, 1.6).',
  },
  {
    dependency: 'typescript',
    requestedVersion: '~5.9.x [confirm-at-exec]',
    selectedVersion: '~5.9.3',
    reason:
      'Latest stable TypeScript 5.9 (npm view typescript@5 version => 5.9.3). ' +
      'Tilde range preserved; supports the ES2023 target (Req 1.4, 3.4).',
  },
  {
    dependency: '@types/node',
    requestedVersion: '^22.x [confirm-at-exec]',
    selectedVersion: '^22.20.0',
    reason:
      'Pinned within the Node 22 line (npm view @types/node@^22 version => 22.20.0) ' +
      'to match the engines lower bound (>=22.0.0). Caret style preserved (Req 1.4).',
  },
  {
    dependency: 'flask',
    requestedVersion: '==3.1.x [confirm-at-exec]',
    selectedVersion: '==3.1.3',
    reason:
      'Latest stable Flask 3.1 on PyPI (3.1.3); exact pin per Req 6.1–6.2.',
  },
  {
    dependency: 'boto3',
    requestedVersion: '==1.40.x [confirm-at-exec]',
    selectedVersion: '==1.43.34',
    reason:
      'Latest stable boto3 on PyPI (1.43.34), superseding the design baseline 1.40.x; ' +
      'no known advisory. Exact pin per Req 6.1–6.2.',
  },
  {
    dependency: 'psycopg[binary,pool]',
    requestedVersion: '==3.3.x [confirm-at-exec]',
    selectedVersion: '==3.3.4',
    reason:
      'Latest stable Psycopg 3.3 on PyPI (3.3.4); [binary,pool] extras preserved. ' +
      'Exact pin per Req 6.1–6.2.',
  },
  {
    dependency: 'PyJWT[crypto] (replaces python-jose[cryptography])',
    requestedVersion: 'PyJWT[crypto]==2.10.x [confirm-at-exec]',
    selectedVersion: 'PyJWT[crypto]==2.13.0',
    reason:
      'python-jose is effectively unmaintained; PyJWT is actively maintained. Latest ' +
      'stable PyJWT on PyPI (2.13.0), superseding the design baseline 2.10.x. Exact ' +
      'pin per Req 6.1–6.3.',
  },
  {
    dependency: 'code-server (vscode-server.yaml pinned install)',
    requestedVersion: '4.105.1 [confirm-at-exec]',
    selectedVersion: '4.125.0',
    reason:
      'Latest stable code-server GitHub release (v4.125.0), superseding the design ' +
      'baseline 4.105.1. Pinned exactly in the bootstrap template (Req 17.6, 17.11).',
  },
  {
    dependency: 'CodeBuild Image (WorkshopStack.yaml)',
    requestedVersion: 'aws/codebuild/amazonlinux-x86_64-standard:5.0 [confirm-at-exec]',
    selectedVersion: 'aws/codebuild/amazonlinux-x86_64-standard:6.0',
    reason:
      'Latest AL2023-based standard x86_64 managed image per CodeBuild docs ' +
      '(ec2-compute-images: :5.0 and :6.0 are both AL2023; :6.0 is the newest standard ' +
      'tag), superseding the design baseline :5.0 (Req 17.7, 17.11).',
  },
];

/**
 * Aurora PostgreSQL engine decision (Req 5.1–5.6).
 *
 * Engine selection (Req 5.1–5.4): the [verify-enum] marker is resolved — VER_15_17
 * was confirmed present in the aws-cdk-lib 2.260.0 `AuroraPostgresEngineVersion`
 * enum, and is the highest 15.x member present. Staying within major 15 keeps the
 * tenant SQL scripts behavior-identical (Req 16).
 *
 * SQL compatibility (Req 5.5, CC5): the bump VER_15_10 -> VER_15_17 is a same-major
 * (15) minor upgrade. PostgreSQL minor releases ship bug/security fixes only and
 * never alter SQL syntax or behavior, so the major version does not change. Direct
 * inspection of both tenant scripts confirms each uses only standard, long-stable
 * DDL/DCL with no version-gated features:
 *   - `tenant-provisioning.sql`: CREATE SCHEMA, CREATE TABLE (INTEGER/TEXT/NUMERIC
 *     column types), CREATE USER ... WITH PASSWORD, and GRANT CONNECT/USAGE/ALL
 *     PRIVILEGES statements.
 *   - `tenant-de-provisioning.sql`: DROP DATABASE and DROP USER statements.
 * None of these constructs were added, deprecated, or changed across PostgreSQL 15.x
 * minors, so both scripts are determined COMPATIBLE with the selected engine version.
 *
 * Setting changes (Req 5.6): a within-major minor bump does not require a new
 * Aurora instance class and introduces no changed/added DB cluster- or
 * instance-parameter-group settings (no parameter defaults change across 15.x
 * minors for the parameters this stack relies on). `settingChanges` is therefore
 * recorded as empty; no instance-class or parameter configuration change is needed.
 */
export const engineDecision: EngineDecision = {
  current: 'VER_15_10',
  selected: 'VER_15_17',
  basis:
    'Highest non-EOL Aurora PostgreSQL 15.x minor present in the aws-cdk-lib 2.260.0 ' +
    'AuroraPostgresEngineVersion enum (verified: enum members VER_15_2..VER_15_17, ' +
    'highest 15.x = VER_15_17). Remaining within major 15 preserves tenant SQL ' +
    'behavior (Req 5.1–5.4). SQL compatibility (Req 5.5): the major version is ' +
    'unchanged (15 -> 15) and inspection of both tenant scripts shows only standard ' +
    'DDL/DCL (CREATE SCHEMA/TABLE/USER, GRANT, DROP DATABASE/USER, INTEGER/TEXT/' +
    'NUMERIC types) with no version-gated features, so both are COMPATIBLE. Setting ' +
    'changes (Req 5.6): a same-major minor bump requires no instance-class change and ' +
    'no DB parameter-group changes, so settingChanges is empty.',
  enumPresent: true,
  // Req 5.5 — compatible/incompatible determination per tenant SQL script.
  sqlCompat: [
    { script: 'tenant-provisioning.sql', compatible: true },
    { script: 'tenant-de-provisioning.sql', compatible: true },
  ],
  // Req 5.6 — no instance-class or DB-parameter changes required for a within-major
  // (15.x) minor upgrade.
  settingChanges: [],
};

/**
 * Version-bearing bootstrap-template elements that were resolved at execution time.
 * Dynamically-resolving elements (AMI "latest" SSM parameters) are marked
 * `no-change-required` per Req 17.8.
 */
export const bootstrapElements: BootstrapElement[] = [
  {
    file: 'static/cfn/vscode-server.yaml',
    location: 'code-server pinned install',
    currentValue: '4.103.2',
    targetValue: '4.125.0',
    dynamic: false,
    status: 'updated',
  },
  {
    file: 'static/cfn/WorkshopStack.yaml',
    location: 'CodeBuild Project Environment Image',
    currentValue: 'aws/codebuild/amazonlinux2-x86_64-standard:5.0',
    targetValue: 'aws/codebuild/amazonlinux-x86_64-standard:6.0',
    dynamic: false,
    status: 'updated',
  },
  {
    file: 'static/cfn/vscode-server.yaml',
    location: 'Mappings AMI SSM parameters (/aws/service/.../latest/...)',
    currentValue: '{{resolve:ssm:/aws/service/...latest...}}',
    targetValue: '{{resolve:ssm:/aws/service/...latest...}}',
    dynamic: true,
    status: 'no-change-required',
    constraintNote:
      'Public "latest" SSM parameters self-resolve to currently supported AMIs; no static change required (Req 17.8).',
  },
];

/**
 * [maintainer-confirm] items and any retained-current constraints recorded for
 * maintainer review rather than guessed (Req 1.6, 5.4, 17.11). Every fast-moving
 * target had a compliant resolvable version, so there are no forced retentions due
 * to "no compliant version"; the entries below are optional forward-moves and a
 * deferred major bump that REQUIRE explicit maintainer confirmation before adoption.
 */
export interface MaintainerConstraint {
  subject: string;
  marker: '[maintainer-confirm]' | '[confirm-at-exec]' | '[verify-enum]';
  decision: 'retain-current' | 'defer-major-bump' | 'optional-forward-move';
  detail: string;
}

export const maintainerConstraints: MaintainerConstraint[] = [
  {
    subject: 'Lambda Python runtime (LambdaFunctionConstruct.ts)',
    marker: '[maintainer-confirm]',
    decision: 'retain-current',
    detail:
      'Runtime.PYTHON_3_13 retained. 3.13 is current and non-deprecated; the in-scope ' +
      'defect is the Flask container mismatch, so the minimal behavior-preserving fix ' +
      'keeps 3.13 and aligns the container to it. Python 3.14 (GA in Lambda, Nov 2025) ' +
      'is an OPTIONAL forward move requiring maintainer confirmation; not adopted automatically.',
  },
  {
    subject: 'cdk-nag major version (2.x -> 3.x)',
    marker: '[confirm-at-exec]',
    decision: 'defer-major-bump',
    detail:
      'cdk-nag 3.0.1 is published and peer-compatible with aws-cdk-lib 2.260.0 ' +
      '(peers: aws-cdk-lib ^2.257.0, constructs ^10.5.1), but the major bump can ' +
      'introduce new/changed nag rules that alter findings. Selected 2.38.2 (latest 2.x) ' +
      'to preserve behavior; adopting 3.x is deferred to maintainer review.',
  },
  {
    subject: 'vscode-server InstanceOperatingSystem allowed list',
    marker: '[confirm-at-exec]',
    decision: 'optional-forward-move',
    detail:
      'Ubuntu-22 may be dropped in favor of Ubuntu-24; both remain supported, so ' +
      'retention is acceptable. Final allowed-list composition recorded for maintainer ' +
      'decision (Req 17.1, 17.9).',
  },
];

/** Full structured assumption log produced by Task 1.4. */
export interface AssumptionLog {
  feature: 'codebase-modernization-refresh';
  task: '1.4';
  resolvedAt: string;
  resolvedVersionSet: VersionSet;
  substitutions: SubstitutionRecord[];
  engineDecision: EngineDecision;
  bootstrapElements: BootstrapElement[];
  maintainerConstraints: MaintainerConstraint[];
}

export const assumptionLog: AssumptionLog = {
  feature: 'codebase-modernization-refresh',
  task: '1.4',
  resolvedAt: RESOLVED_AT,
  resolvedVersionSet,
  substitutions,
  engineDecision,
  bootstrapElements,
  maintainerConstraints,
};
