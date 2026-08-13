/**
 * cdk synth topology snapshot tests for both CDK apps (Task 11.2).
 *
 * Feature: codebase-modernization-refresh
 * Validates: Requirements 16.1, 16.2, 16.4
 *
 * These are snapshot / structural-comparison tests (property-based testing does
 * not apply — see design "Testing Strategy"). They assert that the synthesized
 * stack topology of the two CDK apps is *unchanged* by the modernization refresh,
 * except for diffs an upgrade is forced to introduce (Req 16.4):
 *
 *   - Control_Plane_App  -> <repo-root>/cdk.out
 *   - App_Plane_App      -> <repo-root>/lib/application-plane/cell-app-plane/cdk/cdk.out
 *
 * ## How the snapshot is locked (hermetic, no live `cdk synth`)
 *
 * Rather than shelling out to `cdk synth` (slow, non-deterministic, network /
 * bootstrap dependent), the test derives a deterministic **topology fingerprint**
 * from the committed cloud-assembly artifacts on disk (manifest + templates) via
 * {@link computeTopologyFingerprint}. The fingerprint captures the stack set,
 * each stack's type + resource-type composition, the cross-stack dependency
 * edges, and the deployment-flow order (Req 16.1, 16.2).
 *
 * The first run *locks* the baseline by writing it to a committed fixture
 * (`src/__fixtures__/topology-baseline.<app>.json`); subsequent runs (including
 * the post-refresh assembly) compare the freshly computed fingerprint against
 * that locked baseline and fail on any structural difference. Upgrade-forced
 * diffs (asset hashes, bootstrap version, CDK metadata/analytics, feature-flag
 * report, account id) are normalized away inside the fingerprint, so only a real
 * topology change — a stack added/removed, a changed dependency edge, a changed
 * resource-type composition, or a changed deploy order — can break the test.
 *
 * To intentionally re-lock the baselines (e.g. when a topology change is
 * reviewed and accepted), delete the fixture files and re-run, or run with
 * `UPDATE_TOPOLOGY_BASELINE=1`.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { AppId } from './models';
import {
  AppTopologyFingerprint,
  UPGRADE_FORCED_DIFF_ALLOWLIST,
  computeTopologyFingerprint,
  findDeploymentOrderViolations,
} from './topologyFingerprint';

/** refresh-tooling/ts/src -> refresh-tooling/ts -> refresh-tooling -> <repo-root>. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_DIR = path.join(__dirname, '__fixtures__');

interface AppUnderTest {
  app: AppId;
  label: string;
  outDir: string;
}

const APPS: AppUnderTest[] = [
  {
    app: 'control-plane',
    label: 'Control_Plane_App',
    outDir: path.join(REPO_ROOT, 'cdk.out'),
  },
  {
    app: 'app-plane',
    label: 'App_Plane_App',
    outDir: path.join(
      REPO_ROOT,
      'lib',
      'application-plane',
      'cell-app-plane',
      'cdk',
      'cdk.out'
    ),
  },
];

function baselinePath(app: AppId): string {
  return path.join(FIXTURE_DIR, `topology-baseline.${app}.json`);
}

/**
 * Load the locked baseline fingerprint for an app, writing it on first run (or
 * when UPDATE_TOPOLOGY_BASELINE is set) so the baseline is committed and stable.
 */
function loadOrLockBaseline(
  app: AppId,
  current: AppTopologyFingerprint
): AppTopologyFingerprint {
  const file = baselinePath(app);
  const forceUpdate = process.env.UPDATE_TOPOLOGY_BASELINE === '1';
  if (forceUpdate || !fs.existsSync(file)) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return current;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as AppTopologyFingerprint;
}

describe('cdk synth topology snapshot (Req 16.1, 16.2, 16.4)', () => {
  it('documents the allow-list of permitted upgrade-forced diffs (Req 16.4)', () => {
    // The allow-list is the contract for what is permitted to differ between the
    // pre- and post-refresh assemblies. Lock it so a reviewer must consciously
    // change it.
    expect(UPGRADE_FORCED_DIFF_ALLOWLIST).toMatchSnapshot('upgrade-forced-diff-allowlist');
  });

  describe.each(APPS)('$label ($app)', ({ app, label, outDir }) => {
    it(`has a committed cloud assembly to fingerprint (${label})`, () => {
      expect(fs.existsSync(path.join(outDir, 'manifest.json'))).toBe(true);
    });

    it(`preserves the stack set, types, relationships, and deploy order (${label})`, () => {
      const current = computeTopologyFingerprint(outDir, app);
      const baseline = loadOrLockBaseline(app, current);

      // Stack SET preserved (Req 16.1).
      expect(current.stacks.map((s) => s.name)).toEqual(
        baseline.stacks.map((s) => s.name)
      );

      // Per-stack TYPE, region, RELATIONSHIPS, and resource-type composition
      // preserved (Req 16.1). Compared as a whole structural object so any
      // divergence surfaces with a precise diff.
      expect(current.stacks).toEqual(baseline.stacks);

      // Deployment-flow ORDER preserved (Req 16.2).
      expect(current.deploymentOrder).toEqual(baseline.deploymentOrder);

      // Whole-fingerprint equality — the snapshot assertion (Req 16.1 + 16.2).
      // Only upgrade-forced diffs are normalized out of the fingerprint, so this
      // equality permits exactly those and nothing else (Req 16.4).
      expect(current).toEqual(baseline);
    });

    it(`deployment order is a valid topological order of cross-stack deps (${label})`, () => {
      const current = computeTopologyFingerprint(outDir, app);
      const violations = findDeploymentOrderViolations(
        current.deploymentOrder,
        current.stacks
      );
      expect(violations).toEqual([]);
    });
  });
});
