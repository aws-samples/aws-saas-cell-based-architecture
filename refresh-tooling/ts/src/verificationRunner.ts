/**
 * Verification Runner pipeline (Design Component 10, CC verification suite).
 *
 * Orchestrates the post-refresh Verification_Suite for BOTH CDK apps
 * (Control_Plane_App and App_Plane_App) as an ordered, phase-gated pipeline:
 *
 *   install -> build -> synth -> jest -> cdk-nag -> deploy
 *
 * Each phase runs for both apps and the pipeline only advances to the next phase
 * when the current phase completes successfully, mirroring the requirement
 * chaining ("WHEN X completes successfully THEN run Y"). Each executed step is
 * recorded as a {@link VerificationStep} carrying a success/failure exit status
 * and a detail string. The aggregate {@link VerificationReport} carries a release
 * gate of `releasable` | `blocked`.
 *
 * Behavior (Requirements 10.1–10.7):
 *   - 10.1 install: run dependency installation for both apps; success exit + zero
 *     unresolved dependency errors.
 *   - 10.2 build: run the TypeScript build for both apps; success exit + zero
 *     compilation errors.
 *   - 10.3 synth: run `cdk synth` for both apps; success exit AND a synthesized
 *     template artifact for EVERY expected stack (per-stack artifact assertion).
 *   - 10.4 jest: run the jest suite for both apps; 100% pass, zero failed/errored.
 *   - 10.5 cdk-nag: evaluate; zero findings that are neither resolved nor
 *     explicitly suppressed.
 *   - 10.6 deploy: deployment verification of the refreshed stacks; record, for
 *     each stack, a deployment outcome (success|failure) + final stack status.
 *   - 10.7 fail-safe gate: if any step terminates non-success / failed assertion /
 *     unresolved finding, record the failing step + its detail, set release status
 *     `blocked`, and KEEP it blocked until the recorded failure is resolved and the
 *     affected step is re-run with a passing result (see {@link applyRerun}).
 *
 * The actual command execution (npm install / tsc / cdk synth / jest / cdk-nag /
 * cdk deploy) is INJECTED via a {@link CommandExecutor} so the runner is fully
 * unit-testable without invoking npm/cdk and WITHOUT ever deploying to AWS. The
 * step sequencing, per-stack artifact assertion, aggregation, and release-status
 * logic are pure functions over the executor's outcomes.
 *
 * Interface (design): `runSuite() -> VerificationReport`.
 *
 * Feature: codebase-modernization-refresh
 */
import type { AppId, VerificationReport, VerificationStep } from './models';

/** The pipeline step names, in their fixed execution order (Req 10.1–10.6). */
export type StepName = VerificationStep['name'];

/**
 * The fixed phase order of the Verification_Suite. cfn-validate is part of the
 * bootstrap-template change-class (Req 17.10) and is NOT part of this runner's
 * post-refresh app pipeline, so it is excluded here.
 */
export const STEP_ORDER: readonly Exclude<StepName, 'cfn-validate'>[] = [
  'install',
  'build',
  'synth',
  'jest',
  'cdk-nag',
  'deploy',
] as const;

/** Outcome returned by the injected executor for a single (step, app) invocation. */
export interface CommandOutcome {
  /** Process exit / evaluation status for the command. */
  exitStatus: 'success' | 'failure';
  /** Human-readable detail (error summary, finding count, stack statuses, ...). */
  detail?: string;
  /**
   * For the `synth` step only: the set of stack names that produced a synthesized
   * template artifact. Used for the per-stack artifact assertion (Req 10.3).
   */
  producedStacks?: string[];
  /**
   * For the `deploy` step only: per-stack deployment outcomes including the final
   * stack status reported by the deployment (Req 10.6).
   */
  stackOutcomes?: StackDeployOutcome[];
}

/** Per-stack deployment outcome recorded by the deploy step (Req 10.6). */
export interface StackDeployOutcome {
  stack: string;
  outcome: 'success' | 'failure';
  /** final stack status reported by the deployment, e.g. CREATE_COMPLETE. */
  finalStatus: string;
}

/** Context passed to the executor describing the step being run. */
export interface StepContext {
  step: Exclude<StepName, 'cfn-validate'>;
  app: AppId;
  /** Stacks expected to exist for this app (drives the synth artifact assertion). */
  expectedStacks: string[];
}

/**
 * Injected command executor. Implementations actually run the relevant tool
 * (npm/tsc/cdk/jest/cdk-nag) for the given step+app; tests supply a mock so the
 * suite — including the deploy step — never touches the network or AWS.
 */
export type CommandExecutor = (ctx: StepContext) => CommandOutcome;

/** Per-app configuration: the app id and the stacks it is expected to synthesize. */
export interface AppConfig {
  app: AppId;
  /** Names of every stack expected for this app (per-stack assertions, Req 10.3/10.6). */
  expectedStacks: string[];
}

/** Configuration for {@link runSuite}. */
export interface RunSuiteConfig {
  /** Both apps (Control_Plane_App and App_Plane_App). */
  apps: AppConfig[];
  /** Injected executor performing the real work (mocked in tests). */
  executor: CommandExecutor;
}

/**
 * Assert that synthesis produced a template artifact for every expected stack
 * (Req 10.3). Pure function: returns the missing stacks (empty iff all present).
 */
export function findMissingStackArtifacts(
  expectedStacks: string[],
  producedStacks: string[] | undefined
): string[] {
  const produced = new Set(producedStacks ?? []);
  return expectedStacks.filter((s) => !produced.has(s));
}

/**
 * Derive the release gate from the recorded steps (Req 10.7). Pure function:
 * `blocked` iff any recorded step has a failure exit status, else `releasable`.
 */
export function deriveReleaseStatus(
  steps: VerificationStep[]
): VerificationReport['releaseStatus'] {
  return steps.some((s) => s.exitStatus === 'failure') ? 'blocked' : 'releasable';
}

/**
 * Aggregate recorded steps into a {@link VerificationReport}, applying the
 * release-gate rule (Req 10.7). Pure function over the step list.
 */
export function aggregateReport(steps: VerificationStep[]): VerificationReport {
  return { steps, releaseStatus: deriveReleaseStatus(steps) };
}

/**
 * Evaluate a single step for a single app: invoke the executor and apply any
 * step-specific assertion (the synth per-stack artifact check, Req 10.3). Pure
 * with respect to the injected executor — produces the {@link VerificationStep}
 * record without mutating anything else.
 */
export function evaluateStep(
  step: Exclude<StepName, 'cfn-validate'>,
  appConfig: AppConfig,
  executor: CommandExecutor
): VerificationStep {
  const outcome = executor({
    step,
    app: appConfig.app,
    expectedStacks: appConfig.expectedStacks,
  });

  // A non-success exit status fails the step immediately (Req 10.1, 10.2, 10.4,
  // 10.5, 10.6 success-exit assertions; 10.7 fail-safe).
  if (outcome.exitStatus === 'failure') {
    return {
      name: step,
      app: appConfig.app,
      exitStatus: 'failure',
      detail: outcome.detail ?? `${step} failed for ${appConfig.app}`,
    };
  }

  // synth additionally requires a template artifact for every expected stack
  // (Req 10.3): a successful exit with a missing artifact is still a failure.
  if (step === 'synth') {
    const missing = findMissingStackArtifacts(
      appConfig.expectedStacks,
      outcome.producedStacks
    );
    if (missing.length > 0) {
      return {
        name: step,
        app: appConfig.app,
        exitStatus: 'failure',
        detail:
          `cdk synth for ${appConfig.app} did not produce a template artifact ` +
          `for stack(s): ${missing.join(', ')}`,
      };
    }
  }

  return {
    name: step,
    app: appConfig.app,
    exitStatus: 'success',
    detail: outcome.detail ?? summarizeSuccess(step, appConfig, outcome),
  };
}

/** Build a concise success detail string per step (records per-stack info). */
function summarizeSuccess(
  step: Exclude<StepName, 'cfn-validate'>,
  appConfig: AppConfig,
  outcome: CommandOutcome
): string {
  if (step === 'synth') {
    return `synthesized ${appConfig.expectedStacks.length} stack template artifact(s)`;
  }
  if (step === 'deploy') {
    const outcomes = outcome.stackOutcomes ?? [];
    const summary = outcomes
      .map((o) => `${o.stack}=${o.outcome}(${o.finalStatus})`)
      .join(', ');
    return summary.length > 0 ? `deployed: ${summary}` : 'deploy verification passed';
  }
  return `${step} passed for ${appConfig.app}`;
}

/**
 * Run the full Verification_Suite pipeline (Req 10.1–10.7).
 *
 * The pipeline is phase-gated: each step in {@link STEP_ORDER} runs for every
 * configured app; the pipeline only advances to the next step once the current
 * step has passed for all apps. On the FIRST failing (step, app), the failing
 * step is recorded with its detail and the pipeline halts — no later phases run —
 * and the release status is set to `blocked` (Req 10.7). When every phase passes
 * for every app the release status is `releasable`.
 */
export function runSuite(config: RunSuiteConfig): VerificationReport {
  const steps: VerificationStep[] = [];

  for (const step of STEP_ORDER) {
    let phaseFailed = false;
    for (const appConfig of config.apps) {
      const result = evaluateStep(step, appConfig, config.executor);
      steps.push(result);
      if (result.exitStatus === 'failure') {
        phaseFailed = true;
        break;
      }
    }
    if (phaseFailed) {
      // Fail-safe: stop the pipeline at the first failure (Req 10.7).
      break;
    }
  }

  return aggregateReport(steps);
}

/**
 * Apply a re-run result for a previously failing step (Req 10.7).
 *
 * The release status stays `blocked` until the recorded failure is resolved AND
 * the affected step is re-run with a passing result. This replaces the matching
 * recorded failing step (by name + app) with the re-run result and re-derives the
 * release status. If a passing re-run clears the last remaining failure the gate
 * flips to `releasable`; otherwise it stays `blocked`.
 *
 * Pure function: returns a new report, leaving the input untouched.
 */
export function applyRerun(
  report: VerificationReport,
  rerun: VerificationStep
): VerificationReport {
  let replaced = false;
  const steps = report.steps.map((s) => {
    if (!replaced && s.name === rerun.name && s.app === rerun.app) {
      replaced = true;
      return rerun;
    }
    return s;
  });
  // If the step was never recorded (e.g. it failed before this phase ran), append
  // the re-run result so its outcome is reflected in the gate.
  if (!replaced) {
    steps.push(rerun);
  }
  return aggregateReport(steps);
}
