/**
 * Shared data models for the codebase-modernization-refresh.
 *
 * These are the structured records the refresh produces and consumes. They are the
 * contract between change-classes and the verification/synchronization layers, taken
 * directly from the design document (Data Models section).
 *
 * Feature: codebase-modernization-refresh
 */

/**
 * Canonical CDK dependency set applied to both apps (Control_Plane_App and App_Plane_App).
 * The Alpha_Module equals `awsCdkLib` under the alpha-suffix convention.
 */
export interface VersionSet {
  /** e.g. "2.258.0" */
  awsCdkLib: string;
  /** resolved latest compatible CLI version */
  awsCdkCli: string;
  /** "2.258.0-alpha.0" (== awsCdkLib + alpha suffix) */
  alphaModule: string;
  /** e.g. "^10.4.2" */
  constructs: string;
  /** exact pin */
  cdkNag: string;
  /** e.g. "~5.9.x" */
  typescript: string;
  /** e.g. "^22.x" */
  typesNode: string;
  jest: string;
  tsJest: string;
  tsNode: string;
  /** e.g. ">=22.0.0 <25.0.0" */
  nodeEngines: string;
  /** e.g. "ES2023" */
  ecmaTarget: string;
}

/** Planning record of any version substitution (Req 1.6). */
export interface SubstitutionRecord {
  dependency: string;
  requestedVersion: string;
  selectedVersion: string;
  reason: string;
}

/** Cross-app lockstep comparison result (Req 2). */
export interface LockstepReport {
  matched: string[];
  divergent: { name: string; controlPlane: string; appPlane: string }[];
  missing: { name: string; absentIn: 'control-plane' | 'app-plane' }[];
  isFailure: boolean;
}

/** A single construct-API compatibility finding (Req 7.1). */
export interface CompatInventoryEntry {
  file: string;
  construct: string;
  message: string;
  kind: 'deprecation' | 'error' | 'removed';
  resolution?: string;
}

/** Disposition of a cdk-nag finding (Req 7.4). */
export interface NagDisposition {
  ruleId: string;
  action: 'remediated' | 'suppressed';
  /** required when suppressed */
  justification?: string;
}

/** Runtime alignment across Lambda, Flask base image, and bootstrap runtimes (Req 4). */
export interface AlignmentReport {
  /** e.g. "3.13" */
  lambdaPython: string;
  /** e.g. "3.13" */
  flaskBaseImage: string;
  /** e.g. ["python3.13", ...] */
  bootstrapRuntimes: string[];
  aligned: boolean;
  mismatches: string[];
}

/** Aurora PostgreSQL engine selection decision (Req 5). */
export interface EngineDecision {
  /** "VER_15_10" */
  current: string;
  /** "VER_15_17" */
  selected: string;
  basis: string;
  enumPresent: boolean;
  sqlCompat: { script: string; compatible: boolean }[];
  settingChanges: { setting: string; value: string }[];
}

/** Result of Python dependency pinning and the python-jose -> PyJWT migration (Req 6). */
export interface PythonDepResult {
  /** all "==" exact pins */
  pins: { package: string; version: string }[];
  jwtMigration: {
    from: 'python-jose';
    to: string;
    rationale: string;
    remainingJoseImports: number;
  };
}

/** A single hardened SQL construction site (Req 9). */
export interface HardeningSite {
  file: string;
  line: number;
  positionType: 'value' | 'identifier';
  technique: 'bound-parameter' | 'safe-identifier';
  flaggedForReview: boolean;
}

/**
 * A workshop reference (Line_Anchor or Answer_Key) that points into a code
 * region altered by a Phase 1 security-hardening edit, flagged for Phase 2
 * synchronization (Req 9.6).
 *
 * This is the Phase-2 input recorded by task 8.4: it is consumed by the
 * CC9 line re-anchoring sub-component (task 13) for `referenceType: 'Line_Anchor'`
 * flags and by the CC10 answer-key synchronizer (task 14) for
 * `referenceType: 'Answer_Key'` flags. The flag is the deliverable; the actual
 * re-anchoring / answer-key regeneration happens in Phase 2.
 */
export interface WorkshopSyncFlag {
  /** stable id for the flag */
  id: string;
  /** repository source file hardened in Phase 1 (CC7) */
  sourceFile: string;
  /** human description of the hardened code region that triggered the flag */
  hardenedRegion: string;
  /** which kind of workshop reference is affected */
  referenceType: 'Line_Anchor' | 'Answer_Key';
  /** workshop content file holding the reference (if known) */
  workshopFile?: string;
  /** the lab the reference belongs to (e.g. "lab04") */
  lab?: string;
  /** the anchor kind, for Line_Anchor flags */
  anchorKind?: 'lineNumberStart' | 'highlightLinesStart' | 'prose';
  /** the recorded anchor text/value, e.g. "line 102" */
  anchorText?: string;
  /** the Phase 2 task that consumes this flag */
  phase2Task: '13' | '14';
  /** the requirement clause that mandates the flag */
  requirement: string;
  /** open until the Phase 2 activity resolves it */
  status: 'open' | 'resolved';
}

/**
 * A single out-of-scope entry recorded by the scope-control recorder (Req 16.5, 16.6).
 *
 * Two exclusion kinds are modeled, one per requirement clause:
 *   - `behavior-altering-beyond-upgrade` (Req 16.5): a proposed change that would
 *     alter externally observable functional behavior beyond what an upgrade
 *     requires. The change is excluded and recorded with its reason.
 *   - `no-behavior-preserving-option` (Req 16.6): a required security or version
 *     upgrade for which no available option preserves externally observable
 *     functional behavior. The upgrade is excluded and recorded with an indication
 *     that no behavior-preserving option exists.
 *
 * In both cases the entry is a RECORD of an exclusion: the change/upgrade is NOT
 * applied, and existing behavior is left unchanged. `behaviorUnchanged` is the
 * explicit contract for that invariant and is always `true` for a recorded entry.
 */
export interface OutOfScopeEntry {
  /** stable id for the entry */
  id: string;
  /** which exclusion clause this entry satisfies */
  kind: 'behavior-altering-beyond-upgrade' | 'no-behavior-preserving-option';
  /** the change or upgrade that is excluded from the refresh */
  change: string;
  /** the reason for exclusion (the "no behavior-preserving option exists" indication for 16.6) */
  reason: string;
  /**
   * The scope-control contract: existing behavior is left unchanged because the
   * change is recorded, not applied. Always `true` for a recorded entry.
   */
  behaviorUnchanged: true;
  /** the requirement clause that mandates the exclusion */
  requirement: '16.5' | '16.6';
}

/**
 * The aggregate out-of-scope list / report produced by the recorder (Req 16.5, 16.6).
 * Carries every recorded exclusion and a derived contract flag asserting that no
 * recorded entry was applied (behavior left unchanged across the whole list).
 */
export interface OutOfScopeReport {
  entries: OutOfScopeEntry[];
  /** count of Req 16.5 behavior-altering-beyond-upgrade exclusions */
  behaviorAlteringCount: number;
  /** count of Req 16.6 no-behavior-preserving-option exclusions */
  noBehaviorPreservingOptionCount: number;
  /** true iff every recorded entry leaves behavior unchanged (the change was recorded, not applied) */
  behaviorPreserved: boolean;
}

/** Build-artifact classification of a .js/.d.ts file (Req 8). */
export interface ArtifactClassification {
  path: string;
  hasSiblingTs: boolean;
  classification: 'generated' | 'preserved';
  preserveReason?: 'negation-rule' | 'answer-key' | 'no-sibling-ts';
}

/** A workshop line reference and its re-anchoring status (Req 11). */
export interface LineAnchor {
  workshopFile: string;
  anchorKind: 'lineNumberStart' | 'highlightLinesStart' | 'prose';
  sourceFile: string;
  recordedLine: number;
  /** stable content used to relocate */
  targetRegionMarker: string;
  resolvedLine?: number;
  status: 'updated' | 'unchanged' | 'unresolved';
}

/** An answer key tracked across its four canonical locations (Req 14). */
export interface AnswerKey {
  id: string;
  sourceFile: string;
  /** four canonical locations */
  copies: {
    markdown?: string;
    staticSolution?: string;
    solutionZip?: string;
    repoSolution?: string;
  };
  allByteIdentical: boolean;
  missingLocations: string[];
  divergentLocations: string[];
}

/** Branch-pin / version reconciliation result (Req 13). */
export interface BranchPinReconciliation {
  /** "v1.3.1" */
  currentPin: string;
  /** "1.2.1" */
  repoVersion: string;
  /** higher by semver precedence */
  resolvedTag: string;
  applied: boolean;
  error?: string;
}

/** Preserved-resource-name guard result (Req 15). */
export interface PreservedResourceCheck {
  name: string;
  found: boolean;
  renameRequested: boolean;
  renameImpact?: { stepIds: string[]; screenshots: string[] };
}

/** A version-bearing element in a bootstrap template (Req 17.1). */
export interface BootstrapElement {
  file: string;
  /** parameter / resource path */
  location: string;
  currentValue: string;
  targetValue: string;
  /** self-resolving (AMI/npm@latest) */
  dynamic: boolean;
  status: 'updated' | 'retained' | 'no-change-required';
  constraintNote?: string;
}

/** A single verification-pipeline step result (Req 10). */
export interface VerificationStep {
  name: 'install' | 'build' | 'synth' | 'jest' | 'cdk-nag' | 'deploy' | 'cfn-validate';
  app?: 'control-plane' | 'app-plane';
  exitStatus: 'success' | 'failure';
  detail?: string;
}

/** Aggregate verification report and release gate (Req 10). */
export interface VerificationReport {
  steps: VerificationStep[];
  releaseStatus: 'releasable' | 'blocked';
}

/**
 * Minimal structural view of a `package.json` consumed/produced by the
 * Dependency Upgrade Planner (Req 1, Component 1). Only the fields the planner
 * reads or writes are modeled; unknown fields are preserved untouched.
 */
export interface PackageJson {
  name?: string;
  version?: string;
  engines?: { node?: string; [k: string]: string | undefined };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [k: string]: unknown;
}

/** Identifier for one of the two CDK apps bumped in lockstep. */
export type AppId = 'control-plane' | 'app-plane';

/** A single dependency version change produced by `apply` (Req 1.1–1.5). */
export interface DependencyChange {
  dependency: string;
  section: 'dependencies' | 'devDependencies';
  previousVersion: string;
  selectedVersion: string;
  /** true when the dependency was (and remains) pinned exactly with no range prefix */
  exactPin: boolean;
}

/**
 * Result of applying a {@link VersionSet} to one app's `package.json`
 * (Component 1: `apply(app, VersionSet) -> AppliedResult`).
 */
export interface AppliedResult {
  app: AppId;
  /** the updated package.json object (new value, source left unmutated) */
  packageJson: PackageJson;
  /** every managed CDK_Dependencies entry that was rewritten */
  changes: DependencyChange[];
  /** substitution / style-preservation records (Req 1.6) */
  substitutions: SubstitutionRecord[];
}
