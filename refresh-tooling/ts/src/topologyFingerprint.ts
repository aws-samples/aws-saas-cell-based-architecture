/**
 * CDK synth topology fingerprinting (Task 11.2; Requirements 16.1, 16.2, 16.4).
 *
 * Feature: codebase-modernization-refresh
 *
 * The governing scope-control constraint of the refresh (Requirement 16) is that
 * the refresh is *behavior-preserving*: the synthesized stack topology and the
 * deployment flow of the two CDK apps MUST be identical before and after the
 * refresh, except for the narrow set of diffs that a dependency/runtime upgrade
 * is *forced* to introduce (Req 16.4).
 *
 * This module derives a deterministic, hermetic **topology fingerprint** from a
 * committed CDK cloud assembly (`cdk.out/`). It reads only the synthesized
 * artifacts on disk (`manifest.json` + the per-stack `*.template.json` files) and
 * never invokes a live `cdk synth`, so the snapshot test that consumes it is
 * fully deterministic and offline.
 *
 * The fingerprint captures exactly the four things Req 16.1/16.2 require to be
 * preserved:
 *   1. the **set** of stacks                     (Req 16.1)
 *   2. each stack's **type** + its resource type composition (Req 16.1)
 *   3. the **relationships** (cross-stack dependency edges) (Req 16.1)
 *   4. the **deployment-flow order** of the stacks (Req 16.2)
 *
 * ## Upgrade-forced diffs that are intentionally normalized away (Req 16.4)
 *
 * The fingerprint is computed at *structural* granularity so that the diffs an
 * upgrade is forced to make do not register as topology changes. Specifically,
 * the following are excluded from the fingerprint by construction — they are the
 * explicit allow-list of permitted upgrade-forced diffs:
 *
 *   - **Asset hashes** — `stackTemplateAssetObjectUrl`, S3 asset object keys, and
 *     Lambda/asset content hashes change whenever bundled code or the CDK bundler
 *     changes. Only resource *types* are counted, not asset-hash properties.
 *   - **CDK bootstrap version** — `requiresBootstrapStackVersion` /
 *     `bootstrapStackVersionSsmParameter` track the bootstrap stack and move with
 *     the CLI; manifest properties are not part of the fingerprint.
 *   - **CDK metadata / analytics** — the `AWS::CDK::Metadata` resource's
 *     `Analytics` string and the `aws:cdk:version` metadata embed the library
 *     version. The metadata resource still counts as one `AWS::CDK::Metadata`
 *     resource, but its version-bearing contents are not captured.
 *   - **Feature-flag report** — the `cdk:feature-flag-report` assembly artifact
 *     enumerates version-specific recommended feature flags and is excluded (only
 *     `aws:cloudformation:stack` artifacts form the topology).
 *   - **Tree artifact** (`cdk:tree`) — a synth-side index, not topology.
 *   - **Environment account id** — the `aws://<account>/<region>` environment is
 *     reduced to its region. The region is genuine topology (e.g. the CellRouter
 *     is pinned to `us-east-1`), but the account id is environment-specific and
 *     not a topology property, so it is normalized out to keep the baseline
 *     portable across accounts.
 *   - **Per-cell context id in the App_Plane_App stack name** — the app-plane
 *     per-cell stack is named `Cell-<cellId>`, where `<cellId>` is a CDK *context*
 *     value (e.g. `Cell-cell1` when a `cellId` context is supplied, `Cell-undefined`
 *     when it is not). The cell id is an environment/context-specific placeholder,
 *     not a topology property — exactly analogous to the environment account id —
 *     so the suffix is normalized to a single canonical token (`Cell-<cell>`). The
 *     normalization is applied to the stack name, its deploy-order entry, and any
 *     cross-stack dependency edge that references the per-cell stack, so the stack
 *     set, relationships, and deploy order still compare correctly regardless of
 *     which (or no) `cellId` context was active when the assembly was synthesized.
 *
 * Anything *outside* this allow-list — a stack added or removed, a changed
 * cross-stack dependency edge, a changed resource-type composition, or a changed
 * deployment order — is a real topology change and MUST fail the snapshot test.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { AppId } from './models';

/** The CDK assembly artifact type for a CloudFormation stack. */
const STACK_ARTIFACT_TYPE = 'aws:cloudformation:stack';

/**
 * The explicit allow-list of upgrade-forced diffs that this fingerprint
 * normalizes away (Req 16.4). Captured as data so the snapshot test can document
 * and assert the policy, and so reviewers can see exactly what is permitted to
 * differ between the pre- and post-refresh assemblies.
 */
export const UPGRADE_FORCED_DIFF_ALLOWLIST: readonly string[] = [
  'asset-hashes: stackTemplateAssetObjectUrl, S3 asset keys, Lambda/asset content hashes',
  'bootstrap-version: requiresBootstrapStackVersion, bootstrapStackVersionSsmParameter',
  'cdk-metadata: AWS::CDK::Metadata Analytics string and aws:cdk:version metadata',
  'feature-flag-report: cdk:feature-flag-report assembly artifact',
  'tree-artifact: cdk:tree assembly artifact',
  'environment-account: aws://<account>/<region> reduced to region only',
  'per-cell-context-id: App_Plane_App Cell-<cellId> stack name (and dependency edges) reduced to Cell-<cell>',
] as const;

/** Canonical token the per-cell context id collapses to in the fingerprint. */
const CANONICAL_CELL_STACK_NAME = 'Cell-<cell>';

/**
 * Matches the App_Plane_App per-cell stack name `Cell-<cellId>`, where `<cellId>`
 * is a CDK context value (e.g. `Cell-cell1`, `Cell-undefined`). The control-plane
 * stacks (`Bridge`, `CellManagementSystem`, `CellRouter`, ...) have no `Cell-`
 * prefix-with-hyphen, so this is specific to the per-cell app-plane stack and does
 * not touch any other stack name.
 */
const PER_CELL_STACK_NAME = /^Cell-.+$/;

/**
 * Normalize the App_Plane_App per-cell context placeholder in a stack name
 * (Req 16.4 allow-list). The cell id is an environment/context-specific value,
 * not topology, so `Cell-<cellId>` reduces to a single canonical token. Any name
 * that is not a per-cell stack name is returned unchanged.
 */
export function normalizePerCellStackName(name: string): string {
  return PER_CELL_STACK_NAME.test(name) ? CANONICAL_CELL_STACK_NAME : name;
}

/** Structural topology fingerprint of a single synthesized stack. */
export interface StackFingerprint {
  /** Stack artifact id / display name (the stack set member). */
  name: string;
  /** Assembly artifact type — always `aws:cloudformation:stack` for a stack. */
  type: string;
  /** Deploy region (account id normalized away; region is genuine topology). */
  region: string;
  /**
   * Cross-stack dependency edges (relationships): the names of other stacks this
   * stack depends on, sorted for stable comparison. Asset-manifest and other
   * non-stack dependencies are excluded — they are not topology relationships.
   */
  stackDependencies: string[];
  /**
   * Resource-type composition: a map of CloudFormation resource `Type` to the
   * count of resources of that type in the stack. This captures the stack's
   * "type and relationships" at resource granularity while staying immune to
   * upgrade-forced diffs (logical-id hashes, asset hashes, property changes).
   */
  resourceTypeCounts: Record<string, number>;
}

/** Structural topology fingerprint of one CDK app's cloud assembly. */
export interface AppTopologyFingerprint {
  /** Which app this fingerprint describes. */
  app: AppId;
  /** Every stack in the assembly, sorted by name (the stack set, Req 16.1). */
  stacks: StackFingerprint[];
  /**
   * The deployment-flow order (Req 16.2): the order in which CDK emits the
   * stacks in the manifest, which respects cross-stack dependencies. Verified to
   * be a valid topological order of {@link StackFingerprint.stackDependencies}.
   */
  deploymentOrder: string[];
}

interface RawManifestArtifact {
  type: string;
  environment?: string;
  dependencies?: string[];
  properties?: { templateFile?: string };
}

interface RawManifest {
  artifacts: Record<string, RawManifestArtifact>;
}

/** Reduce an `aws://<account>/<region>` environment string to its region. */
export function regionOfEnvironment(environment: string | undefined): string {
  if (!environment) return 'unknown-region';
  const region = environment.split('/').pop();
  return region && region.length > 0 ? region : 'unknown-region';
}

/**
 * Count CloudFormation resources by their `Type` within a synthesized template.
 * Property-level content (asset hashes, version strings, logical-id suffixes) is
 * deliberately ignored so only the structural resource-type composition is
 * captured (Req 16.4 allow-list).
 */
export function countResourceTypes(template: {
  Resources?: Record<string, { Type?: string }>;
}): Record<string, number> {
  const counts: Record<string, number> = {};
  const resources = template.Resources ?? {};
  for (const resource of Object.values(resources)) {
    const type = resource?.Type ?? '<unknown>';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  // Return a key-sorted object for stable, reviewable fingerprints.
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  );
}

/**
 * Verify that `order` is a valid topological order with respect to the given
 * cross-stack dependency edges: for every stack, each of its dependencies must
 * appear earlier in the order. Returns the list of violations (empty iff valid).
 *
 * This is the machine-checkable form of "the deployment flow is preserved"
 * (Req 16.2): a valid deploy order never deploys a stack before a stack it
 * depends on.
 */
export function findDeploymentOrderViolations(
  order: string[],
  stacks: StackFingerprint[]
): string[] {
  const position = new Map<string, number>();
  order.forEach((name, i) => position.set(name, i));
  const violations: string[] = [];
  for (const stack of stacks) {
    const stackPos = position.get(stack.name);
    if (stackPos === undefined) {
      violations.push(`stack "${stack.name}" is absent from the deployment order`);
      continue;
    }
    for (const dep of stack.stackDependencies) {
      const depPos = position.get(dep);
      if (depPos === undefined) {
        violations.push(
          `dependency "${dep}" of "${stack.name}" is absent from the deployment order`
        );
      } else if (depPos >= stackPos) {
        violations.push(
          `"${stack.name}" (pos ${stackPos}) is ordered before its dependency "${dep}" (pos ${depPos})`
        );
      }
    }
  }
  return violations;
}

/**
 * Compute the {@link AppTopologyFingerprint} for a synthesized cloud assembly.
 *
 * @param outDir  Absolute path to the app's `cdk.out` directory.
 * @param app     Which app the assembly belongs to.
 */
export function computeTopologyFingerprint(
  outDir: string,
  app: AppId
): AppTopologyFingerprint {
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RawManifest;

  // The set of stack artifacts (Req 16.1). Non-stack artifacts (asset manifests,
  // the tree, the feature-flag report) are excluded from the topology.
  const stackEntries = Object.entries(manifest.artifacts).filter(
    ([, artifact]) => artifact.type === STACK_ARTIFACT_TYPE
  );
  const stackNames = new Set(stackEntries.map(([name]) => name));

  // Deployment-flow order = the order CDK emits the stacks in the manifest, which
  // respects cross-stack dependencies (Req 16.2). The per-cell context id in the
  // app-plane stack name is normalized away (Req 16.4 allow-list).
  const deploymentOrder = stackEntries.map(([name]) =>
    normalizePerCellStackName(name)
  );

  const stacks: StackFingerprint[] = stackEntries.map(([name, artifact]) => {
    // Relationships: keep only stack -> stack dependency edges (Req 16.1). The
    // per-cell context id is normalized in the edge references too, so
    // relationships still compare correctly regardless of the active cellId.
    const stackDependencies = (artifact.dependencies ?? [])
      .filter((dep) => stackNames.has(dep))
      .map((dep) => normalizePerCellStackName(dep))
      .sort((a, b) => a.localeCompare(b));

    const templateFile = artifact.properties?.templateFile;
    if (!templateFile) {
      throw new Error(`manifest stack artifact "${name}" has no templateFile`);
    }
    const template = JSON.parse(
      fs.readFileSync(path.join(outDir, templateFile), 'utf8')
    ) as { Resources?: Record<string, { Type?: string }> };

    return {
      name: normalizePerCellStackName(name),
      type: artifact.type,
      region: regionOfEnvironment(artifact.environment),
      stackDependencies,
      resourceTypeCounts: countResourceTypes(template),
    };
  });

  // Sort stacks by name so the fingerprint is order-independent for the *set*
  // comparison; deployment order is captured separately and explicitly.
  stacks.sort((a, b) => a.name.localeCompare(b.name));

  return { app, stacks, deploymentOrder };
}
