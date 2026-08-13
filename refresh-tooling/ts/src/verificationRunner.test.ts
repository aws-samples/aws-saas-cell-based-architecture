/**
 * Unit tests for the Verification Runner pipeline (Design Component 10).
 *
 * Requirements covered: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7.
 *
 * The executor is mocked so no npm/cdk command runs and nothing deploys to AWS.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  runSuite,
  evaluateStep,
  applyRerun,
  aggregateReport,
  deriveReleaseStatus,
  findMissingStackArtifacts,
  STEP_ORDER,
  type AppConfig,
  type CommandExecutor,
  type CommandOutcome,
  type StepContext,
} from './verificationRunner';
import type { VerificationStep } from './models';

const APPS: AppConfig[] = [
  { app: 'control-plane', expectedStacks: ['CellManagementSystem', 'Bridge'] },
  { app: 'app-plane', expectedStacks: ['CellProvisioningSystem', 'CellRouter'] },
];

/** Executor where every step succeeds, producing all artifacts and deploy outcomes. */
const allPassExecutor: CommandExecutor = (ctx: StepContext): CommandOutcome => {
  if (ctx.step === 'synth') {
    return { exitStatus: 'success', producedStacks: [...ctx.expectedStacks] };
  }
  if (ctx.step === 'deploy') {
    return {
      exitStatus: 'success',
      stackOutcomes: ctx.expectedStacks.map((stack) => ({
        stack,
        outcome: 'success' as const,
        finalStatus: 'CREATE_COMPLETE',
      })),
    };
  }
  return { exitStatus: 'success' };
};

describe('findMissingStackArtifacts (Req 10.3)', () => {
  it('returns empty when every expected stack produced an artifact', () => {
    expect(findMissingStackArtifacts(['A', 'B'], ['A', 'B', 'C'])).toEqual([]);
  });

  it('returns the stacks missing a template artifact', () => {
    expect(findMissingStackArtifacts(['A', 'B'], ['A'])).toEqual(['B']);
    expect(findMissingStackArtifacts(['A', 'B'], undefined)).toEqual(['A', 'B']);
  });
});

describe('deriveReleaseStatus / aggregateReport (Req 10.7)', () => {
  it('is releasable when no step failed', () => {
    const steps: VerificationStep[] = [
      { name: 'install', app: 'control-plane', exitStatus: 'success' },
    ];
    expect(deriveReleaseStatus(steps)).toBe('releasable');
    expect(aggregateReport(steps).releaseStatus).toBe('releasable');
  });

  it('is blocked when any step failed', () => {
    const steps: VerificationStep[] = [
      { name: 'install', app: 'control-plane', exitStatus: 'success' },
      { name: 'build', app: 'app-plane', exitStatus: 'failure', detail: 'tsc error' },
    ];
    expect(deriveReleaseStatus(steps)).toBe('blocked');
    expect(aggregateReport(steps).releaseStatus).toBe('blocked');
  });
});

describe('runSuite — all pass (Req 10.1–10.6)', () => {
  it('runs every step for both apps and returns releasable', () => {
    const report = runSuite({ apps: APPS, executor: allPassExecutor });

    expect(report.releaseStatus).toBe('releasable');
    // 6 steps x 2 apps = 12 recorded steps.
    expect(report.steps).toHaveLength(STEP_ORDER.length * APPS.length);
    expect(report.steps.every((s) => s.exitStatus === 'success')).toBe(true);

    // Steps appear in the fixed pipeline order, phase by phase.
    const order = report.steps.filter((s) => s.app === 'control-plane').map((s) => s.name);
    expect(order).toEqual([...STEP_ORDER]);
  });

  it('records per-stack deploy outcomes with a final stack status (Req 10.6)', () => {
    const report = runSuite({ apps: APPS, executor: allPassExecutor });
    const deploy = report.steps.find((s) => s.name === 'deploy');
    expect(deploy?.exitStatus).toBe('success');
    expect(deploy?.detail).toMatch(/CREATE_COMPLETE/);
  });
});

describe('runSuite — a failing step blocks the release (Req 10.7)', () => {
  it('records the failing step + detail, sets blocked, and halts the pipeline', () => {
    const executor: CommandExecutor = (ctx) => {
      if (ctx.step === 'build' && ctx.app === 'app-plane') {
        return { exitStatus: 'failure', detail: 'TS2345: type error in CellStack.ts' };
      }
      return allPassExecutor(ctx);
    };

    const report = runSuite({ apps: APPS, executor });

    expect(report.releaseStatus).toBe('blocked');

    const failing = report.steps.find((s) => s.exitStatus === 'failure');
    expect(failing).toBeDefined();
    expect(failing?.name).toBe('build');
    expect(failing?.app).toBe('app-plane');
    expect(failing?.detail).toMatch(/TS2345/);

    // Pipeline halted at the failing phase: no synth/jest/cdk-nag/deploy ran.
    const ranSteps = new Set(report.steps.map((s) => s.name));
    expect(ranSteps.has('synth')).toBe(false);
    expect(ranSteps.has('deploy')).toBe(false);
  });

  it('blocks when synth succeeds but a stack template artifact is missing (Req 10.3)', () => {
    const executor: CommandExecutor = (ctx) => {
      if (ctx.step === 'synth' && ctx.app === 'control-plane') {
        return { exitStatus: 'success', producedStacks: ['CellManagementSystem'] };
      }
      return allPassExecutor(ctx);
    };

    const report = runSuite({ apps: APPS, executor });
    expect(report.releaseStatus).toBe('blocked');
    const synth = report.steps.find((s) => s.name === 'synth' && s.exitStatus === 'failure');
    expect(synth?.detail).toMatch(/Bridge/);
  });

  it('blocks on an unresolved cdk-nag finding (Req 10.5)', () => {
    const executor: CommandExecutor = (ctx) => {
      if (ctx.step === 'cdk-nag' && ctx.app === 'control-plane') {
        return { exitStatus: 'failure', detail: '3 unresolved, unsuppressed findings' };
      }
      return allPassExecutor(ctx);
    };
    const report = runSuite({ apps: APPS, executor });
    expect(report.releaseStatus).toBe('blocked');
    expect(report.steps.find((s) => s.name === 'cdk-nag')?.exitStatus).toBe('failure');
  });
});

describe('evaluateStep (Req 10.3 synth assertion)', () => {
  it('fails a synth that exits success but omits a stack artifact', () => {
    const step = evaluateStep(
      'synth',
      { app: 'control-plane', expectedStacks: ['A', 'B'] },
      () => ({ exitStatus: 'success', producedStacks: ['A'] })
    );
    expect(step.exitStatus).toBe('failure');
    expect(step.detail).toMatch(/B/);
  });

  it('passes a synth that produces every expected artifact', () => {
    const step = evaluateStep(
      'synth',
      { app: 'control-plane', expectedStacks: ['A', 'B'] },
      () => ({ exitStatus: 'success', producedStacks: ['A', 'B'] })
    );
    expect(step.exitStatus).toBe('success');
  });
});

describe('applyRerun — stays blocked until resolved & re-run passing (Req 10.7)', () => {
  it('flips to releasable only after the failing step re-runs with a passing result', () => {
    const executor: CommandExecutor = (ctx) => {
      if (ctx.step === 'jest' && ctx.app === 'control-plane') {
        return { exitStatus: 'failure', detail: '2 failed tests' };
      }
      return allPassExecutor(ctx);
    };

    const blocked = runSuite({ apps: APPS, executor });
    expect(blocked.releaseStatus).toBe('blocked');

    // A re-run that still fails keeps the release blocked.
    const stillBlocked = applyRerun(blocked, {
      name: 'jest',
      app: 'control-plane',
      exitStatus: 'failure',
      detail: '1 failed test',
    });
    expect(stillBlocked.releaseStatus).toBe('blocked');

    // A passing re-run of the recorded failing step clears the gate.
    const resolved = applyRerun(stillBlocked, {
      name: 'jest',
      app: 'control-plane',
      exitStatus: 'success',
      detail: 'all tests pass',
    });
    expect(resolved.releaseStatus).toBe('releasable');
  });

  it('does not mutate the input report', () => {
    const before = aggregateReport([
      { name: 'install', app: 'control-plane', exitStatus: 'failure', detail: 'x' },
    ]);
    const after = applyRerun(before, {
      name: 'install',
      app: 'control-plane',
      exitStatus: 'success',
    });
    expect(before.releaseStatus).toBe('blocked');
    expect(after.releaseStatus).toBe('releasable');
    expect(before.steps[0].exitStatus).toBe('failure');
  });
});
