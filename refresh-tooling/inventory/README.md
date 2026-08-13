# Construct-API Compatibility Inventory (Task 4.1, CC3)

`compat-inventory.json` is the recorded Construct-API compatibility inventory for
both CDK apps under `aws-cdk-lib` 2.260.0 (Requirement 7.1, Design Component 3).

## How it was produced

For each app, `tsc --noEmit` and `cdk synth --quiet` were run under aws-cdk-lib
2.260.0, and the construct-API diagnostics were captured into `raw/*.log`. The
Construct-API Remediator parser (`ts/src/constructApiRemediator.ts`) turns that raw
output into `CompatInventoryEntry` records and attributes each deprecation warning to
the repository source file(s) using the deprecated member.

Regenerate with:

```
cd refresh-tooling/ts && npx ts-node src/generateCompatInventory.ts
```

## Findings

- **Control_Plane_App** — `tsc` clean; `cdk synth` succeeded with **2 construct-API
  deprecation warnings**:
  1. `aws-cdk-lib.aws_dynamodb.TableOptions#pointInTimeRecovery` →
     `cell-management-system-stack.ts` (use `pointInTimeRecoverySpecification`).
  2. `aws-cdk-lib.aws_lambda.FunctionOptions#logRetention` →
     `app-plane-staggered-deployment-construct.ts` (use `logGroup`).
- **App_Plane_App** — `tsc` clean; `cdk synth` succeeded with **zero** construct-API
  deprecation warnings and zero compile/removed-API errors. Empty inventory is a
  valid, good result.

## Scope note

This inventory records construct-API compatibility findings only (deprecation /
compile error / removed API). `cdk-nag` findings observed during synth (e.g.
`AwsSolutions-COG8`, `COG2`, `APIG3`) are NOT construct-API compatibility issues —
they are security-posture findings handled as NagDispositions in task 4.4 and
recorded separately in `nag-dispositions.json`.

## cdk-nag dispositions (Task 4.4, Requirement 7.4)

`nag-dispositions.json` records the cdk-nag disposition for every finding surfaced
under the upgraded `aws-cdk-lib` 2.260.0 / `cdk-nag` 2.38.2. The pre-refresh
`cdk.out/*-NagReport.csv` baselines were backed up, both apps were re-synthesized,
and the resulting NagReports were diffed against the baseline by (Rule ID,
Resource ID).

- The upgrade produced **no new (Rule ID, Resource ID) rows** in either app — the
  upgraded cdk-nag reports the same rule/resource set as the 2.36.18 baseline.
- The findings that were **Non-Compliant** in the baseline reports (Control_Plane_App
  `AwsSolutions-COG8`; App_Plane_App `AwsSolutions-COG8`, `COG2`, `APIG3`) are now
  **suppressed** via the repository's existing `CdkNagUtils.suppressCDKNag` →
  `NagSuppressions.addStackSuppressions` utilities, each with a written justification
  referencing the rule id.
- After re-synthesis both apps report **zero unresolved, unsuppressed findings**
  (Control_Plane_App: 0 Non-Compliant; App_Plane_App `Cell-cell1`: 0 Non-Compliant).

The `cdk synth` Python Lambda asset bundling requires a container runtime; the local
finch VM was initialized so synth could complete (`CDK_DOCKER=finch`).
