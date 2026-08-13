/**
 * Generator for the recorded Construct-API compatibility inventory artifact.
 *
 * Reads the raw `tsc` + `cdk synth` diagnostics captured (under aws-cdk-lib 2.260.0)
 * for both apps from `refresh-tooling/inventory/raw/*.log`, runs them through the
 * Construct-API Remediator parser ({@link buildCompatInventory}), attributes each
 * deprecation warning to the repository source file(s) that use the deprecated
 * member, and writes the structured artifact to
 * `refresh-tooling/inventory/compat-inventory.json`.
 *
 * This artifact is the input to task 4.2 (apply minimal API fixes).
 *
 * Run with: `npx ts-node src/generateCompatInventory.ts`
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildCompatInventory, SourceFile, CompatInventory } from './constructApiRemediator';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INVENTORY_DIR = path.join(REPO_ROOT, 'refresh-tooling', 'inventory');
const RAW_DIR = path.join(INVENTORY_DIR, 'raw');

const APP_PLANE_CDK_REL = 'lib/application-plane/cell-app-plane/cdk';

/** Recursively collect repository-relative `.ts` source files under `absRoot`. */
function collectSourceFiles(
  absRoot: string,
  opts: { excludeAbs?: string[] } = {}
): SourceFile[] {
  const out: SourceFile[] = [];
  const exclude = opts.excludeAbs ?? [];

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (exclude.some((e) => abs === e || abs.startsWith(e + path.sep))) {
        continue;
      }
      if (name === 'node_modules' || name === 'cdk.out' || name === 'Solution') {
        continue;
      }
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        walk(abs);
      } else if (
        name.endsWith('.ts') &&
        !name.endsWith('.d.ts') &&
        !name.endsWith('.test.ts')
      ) {
        out.push({
          path: path.relative(REPO_ROOT, abs),
          content: fs.readFileSync(abs, 'utf8'),
        });
      }
    }
  };

  walk(absRoot);
  return out;
}

function readLog(name: string): string {
  const p = path.join(RAW_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

export interface AppInventory {
  app: 'control-plane' | 'app-plane';
  entries: CompatInventory;
}

export interface CompatInventoryArtifact {
  feature: string;
  task: string;
  awsCdkLib: string;
  generatedFrom: string;
  apps: AppInventory[];
  totalEntries: number;
}

export function generate(): CompatInventoryArtifact {
  // Control_Plane_App sources: everything under lib/ and bin/, excluding the nested
  // App_Plane_App CDK app (which is inventoried separately) and answer keys.
  const controlPlaneSources = [
    ...collectSourceFiles(path.join(REPO_ROOT, 'lib'), {
      excludeAbs: [path.join(REPO_ROOT, APP_PLANE_CDK_REL)],
    }),
    ...collectSourceFiles(path.join(REPO_ROOT, 'bin')),
  ];
  const appPlaneSources = collectSourceFiles(path.join(REPO_ROOT, APP_PLANE_CDK_REL));

  const controlPlane = buildCompatInventory({
    tscOutput: readLog('control-plane.tsc.log'),
    synthOutput: readLog('control-plane.synth.log'),
    sourceFiles: controlPlaneSources,
  });
  const appPlane = buildCompatInventory({
    tscOutput: readLog('app-plane.tsc.log'),
    synthOutput: readLog('app-plane.synth.log'),
    sourceFiles: appPlaneSources,
  });

  const artifact: CompatInventoryArtifact = {
    feature: 'codebase-modernization-refresh',
    task: '4.1 Construct-API Remediator inventory',
    awsCdkLib: '2.260.0',
    generatedFrom: 'tsc --noEmit + cdk synth --quiet (both apps), captured in inventory/raw/',
    apps: [
      { app: 'control-plane', entries: controlPlane },
      { app: 'app-plane', entries: appPlane },
    ],
    totalEntries: controlPlane.length + appPlane.length,
  };
  return artifact;
}

if (require.main === module) {
  const artifact = generate();
  const outPath = path.join(INVENTORY_DIR, 'compat-inventory.json');
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath} (${artifact.totalEntries} entries)`);
}
