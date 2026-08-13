/**
 * Unit tests for the Bootstrap Inventory Builder (CC13 — Bootstrap template currency).
 *
 * Requirements covered: 17.1, 17.2, 17.8.
 *
 * Feature: codebase-modernization-refresh
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildBootstrapInventory,
  buildBootstrapInventoryFromFiles,
  deriveStatus,
  normalizeList,
  NOT_FOUND,
  VSCODE_SERVER_FILE,
  WORKSHOP_STACK_FILE,
  VSCODE_SERVER_RELATIVE_PATH,
  BOOTSTRAP_WORKSHOP_STACK_PATH,
  type BootstrapTemplateContents,
} from './bootstrapInventoryBuilder';
import type { BootstrapElement } from './models';

/**
 * Minimal but representative fixtures mirroring the real template structure
 * (current values per the design Target Version Matrix "current" column).
 */
const VSCODE_FIXTURE = `Description: Create a VSCode code-server instance
Parameters:
  InstanceType:
    Type: String
    Default: t4g.medium
  InstanceOperatingSystem:
    Type: String
    Default: AmazonLinux-2023
    AllowedValues: ['AmazonLinux-2023', 'Ubuntu-22', 'Ubuntu-24']
Mappings:
  ArmImage:
    Ubuntu-22:
      ImageId: '{{resolve:ssm:/aws/service/canonical/ubuntu/server/jammy/stable/current/arm64/hvm/ebs-gp2/ami-id}}'
    Ubuntu-24:
      ImageId: '{{resolve:ssm:/aws/service/canonical/ubuntu/server/noble/stable/current/arm64/hvm/ebs-gp3/ami-id}}'
    AmazonLinux-2023:
      ImageId: '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64}}'
  AmdImage:
    Ubuntu-22:
      ImageId: '{{resolve:ssm:/aws/service/canonical/ubuntu/server/jammy/stable/current/amd64/hvm/ebs-gp2/ami-id}}'
    Ubuntu-24:
      ImageId: '{{resolve:ssm:/aws/service/canonical/ubuntu/server/noble/stable/current/amd64/hvm/ebs-gp3/ami-id}}'
    AmazonLinux-2023:
      ImageId: '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}'
Resources:
  SecretPlaintextLambda:
    Type: AWS::Lambda::Function
    Properties:
      Handler: index.lambda_handler
      Runtime: python3.12
  RunSSMDocLambda:
    Type: AWS::Lambda::Function
    Properties:
      Handler: index.lambda_handler
      Runtime: python3.12
  VSCodeInstanceSSMDoc:
    Type: AWS::SSM::Document
    Properties:
      Content:
        parameters:
          NodeVersion:
            type: String
            default: '22'
            allowedValues:
              - '22'
              - '20'
              - '18'
          DotNetVersion:
            type: String
            default: '8.0'
            allowedValues:
              - '8.0'
              - '7.0'
        mainSteps:
          - inputs:
              runCommand:
                - curl -fsSL https://code-server.dev/install.sh | bash -s -- --version 4.103.2 2>&1
  VSCodeHealthCheckLambda:
    Type: AWS::Lambda::Function
    Properties:
      Handler: index.lambda_handler
      Runtime: python3.12
`;

const WORKSHOP_FIXTURE = `Resources:
  InstallWorkshopStack:
    Type: AWS::CodeBuild::Project
    Properties:
      Environment:
        ComputeType: BUILD_GENERAL1_SMALL
        Image: aws/codebuild/amazonlinux2-x86_64-standard:5.0
        Type: LINUX_CONTAINER
  TriggerCodeBuild:
    Type: AWS::Lambda::Function
    Properties:
      Handler: index.lambda_handler
      Runtime: python3.11
`;

const FIXTURE: BootstrapTemplateContents = {
  vscodeServer: VSCODE_FIXTURE,
  workshopStack: WORKSHOP_FIXTURE,
};

function findElement(
  inv: BootstrapElement[],
  file: string,
  location: string
): BootstrapElement {
  const el = inv.find((e) => e.file === file && e.location === location);
  if (!el) {
    throw new Error(`element not found: ${file} :: ${location}`);
  }
  return el;
}

describe('deriveStatus', () => {
  it('marks dynamic elements as no-change-required regardless of values', () => {
    expect(deriveStatus(true, 'anything', 'something-else')).toBe('no-change-required');
  });

  it('marks unchanged non-dynamic elements as retained', () => {
    expect(deriveStatus(false, '22', '22')).toBe('retained');
  });

  it('marks changed non-dynamic elements as updated', () => {
    expect(deriveStatus(false, 'python3.12', 'python3.13')).toBe('updated');
  });
});

describe('buildBootstrapInventory (pure)', () => {
  const inv = buildBootstrapInventory(FIXTURE);

  it('enumerates every version-bearing element across both templates (Req 17.1)', () => {
    // 3 lambda runtimes + NodeVersion(2) + DotNetVersion(2) + code-server +
    // InstanceType + InstanceOperatingSystem(2) + 6 AMI SSM params
    // + WorkshopStack lambda runtime + CodeBuild Image = 19
    expect(inv).toHaveLength(19);
    expect(inv.filter((e) => e.file === VSCODE_SERVER_FILE)).toHaveLength(17);
    expect(inv.filter((e) => e.file === WORKSHOP_STACK_FILE)).toHaveLength(2);
  });

  it('reads actual current values from the template text (Req 17.1)', () => {
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'Resources.SecretPlaintextLambda.Properties.Runtime')
        .currentValue
    ).toBe('python3.12');
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'SSM document parameter NodeVersion.default')
        .currentValue
    ).toBe('22');
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'SSM document parameter NodeVersion.allowedValues')
        .currentValue
    ).toBe(normalizeList(['22', '20', '18']));
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'SSM document parameter DotNetVersion.allowedValues')
        .currentValue
    ).toBe(normalizeList(['8.0', '7.0']));
    expect(
      findElement(
        inv,
        VSCODE_SERVER_FILE,
        'Resources VSCodeInstanceSSMDoc install code-server --version'
      ).currentValue
    ).toBe('4.103.2');
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'Parameters.InstanceType.Default').currentValue
    ).toBe('t4g.medium');
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'Parameters.InstanceOperatingSystem.AllowedValues')
        .currentValue
    ).toBe(normalizeList(['AmazonLinux-2023', 'Ubuntu-22', 'Ubuntu-24']));
    expect(
      findElement(inv, WORKSHOP_STACK_FILE, 'Resources.TriggerCodeBuild.Properties.Runtime')
        .currentValue
    ).toBe('python3.11');
    expect(
      findElement(
        inv,
        WORKSHOP_STACK_FILE,
        'Resources.InstallWorkshopStack.Properties.Environment.Image'
      ).currentValue
    ).toBe('aws/codebuild/amazonlinux2-x86_64-standard:5.0');
  });

  it('targets the inline Lambda runtimes to python3.13 and marks them updated (Req 17.3)', () => {
    for (const loc of [
      'Resources.SecretPlaintextLambda.Properties.Runtime',
      'Resources.RunSSMDocLambda.Properties.Runtime',
      'Resources.VSCodeHealthCheckLambda.Properties.Runtime',
    ]) {
      const el = findElement(inv, VSCODE_SERVER_FILE, loc);
      expect(el.targetValue).toBe('python3.13');
      expect(el.dynamic).toBe(false);
      expect(el.status).toBe('updated');
    }
    const wsLambda = findElement(
      inv,
      WORKSHOP_STACK_FILE,
      'Resources.TriggerCodeBuild.Properties.Runtime'
    );
    expect(wsLambda.targetValue).toBe('python3.13');
    expect(wsLambda.status).toBe('updated');
  });

  it('updates the NodeVersion/DotNetVersion allowed lists and code-server (Req 17.4-17.6)', () => {
    const nodeAllowed = findElement(
      inv,
      VSCODE_SERVER_FILE,
      'SSM document parameter NodeVersion.allowedValues'
    );
    expect(nodeAllowed.targetValue).toBe(normalizeList(['24', '22']));
    expect(nodeAllowed.status).toBe('updated');

    const dotnetDefault = findElement(
      inv,
      VSCODE_SERVER_FILE,
      'SSM document parameter DotNetVersion.default'
    );
    expect(dotnetDefault.targetValue).toBe('10.0');
    expect(dotnetDefault.status).toBe('updated');

    const codeServer = findElement(
      inv,
      VSCODE_SERVER_FILE,
      'Resources VSCodeInstanceSSMDoc install code-server --version'
    );
    expect(codeServer.targetValue).toBe('4.105.1');
    expect(codeServer.status).toBe('updated');
  });

  it('retains compatible elements (NodeVersion default, InstanceType, OS default)', () => {
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'SSM document parameter NodeVersion.default').status
    ).toBe('retained');
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'Parameters.InstanceType.Default').status
    ).toBe('retained');
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'Parameters.InstanceOperatingSystem.Default').status
    ).toBe('retained');
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'Parameters.InstanceOperatingSystem.AllowedValues')
        .status
    ).toBe('retained');
  });

  it('marks the AMI SSM parameters dynamic + no-change-required (Req 17.8)', () => {
    const amiElements = inv.filter((e) => e.location.includes('.ImageId'));
    expect(amiElements).toHaveLength(6);
    for (const el of amiElements) {
      expect(el.dynamic).toBe(true);
      expect(el.status).toBe('no-change-required');
      // A dynamic element is left unchanged: target mirrors current.
      expect(el.targetValue).toBe(el.currentValue);
      expect(el.currentValue).toContain('resolve:ssm');
    }
  });

  it('targets the CodeBuild image to the AL2023 standard image (Req 17.7)', () => {
    const image = findElement(
      inv,
      WORKSHOP_STACK_FILE,
      'Resources.InstallWorkshopStack.Properties.Environment.Image'
    );
    expect(image.targetValue).toBe('aws/codebuild/amazonlinux-x86_64-standard:5.0');
    expect(image.status).toBe('updated');
  });

  it('never leaves a current value blank for non-dynamic elements in a well-formed template', () => {
    for (const el of inv) {
      if (!el.dynamic) {
        expect(el.currentValue).not.toBe(NOT_FOUND);
        expect(el.currentValue.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('buildBootstrapInventory (missing element handling)', () => {
  it('records NOT_FOUND with a maintainer note when a value cannot be located', () => {
    const inv = buildBootstrapInventory({ vscodeServer: '', workshopStack: '' });
    const el = findElement(
      inv,
      VSCODE_SERVER_FILE,
      'Resources.SecretPlaintextLambda.Properties.Runtime'
    );
    expect(el.currentValue).toBe(NOT_FOUND);
    expect(el.constraintNote).toMatch(/not-found/i);
  });
});

describe('buildBootstrapInventoryFromFiles (filesystem-backed)', () => {
  // The companion workshop repository sits beside this code repository.
  const candidateRoots = [
    path.resolve(
      __dirname,
      '../../../../building-resilient-and-scalable-saas-applications-with-a-cell-based-architecture'
    ),
  ];
  const workshopRoot = candidateRoots.find(
    (r) =>
      fs.existsSync(path.join(r, VSCODE_SERVER_RELATIVE_PATH)) &&
      fs.existsSync(path.join(r, BOOTSTRAP_WORKSHOP_STACK_PATH))
  );

  const maybe = workshopRoot ? it : it.skip;

  maybe('builds the inventory from the real bootstrap templates', () => {
    const inv = buildBootstrapInventoryFromFiles(workshopRoot as string);
    expect(inv).toHaveLength(19);
    // Real templates now carry python3.13 after CC13 (task 17.2/17.3): the vscode
    // inline Lambda and the workshop trigger Lambda were both aligned to python3.13.
    expect(
      findElement(inv, VSCODE_SERVER_FILE, 'Resources.SecretPlaintextLambda.Properties.Runtime')
        .currentValue
    ).toBe('python3.13');
    expect(
      findElement(inv, WORKSHOP_STACK_FILE, 'Resources.TriggerCodeBuild.Properties.Runtime')
        .currentValue
    ).toBe('python3.13');
    // Every non-dynamic element resolved a concrete current value.
    for (const el of inv) {
      if (!el.dynamic) {
        expect(el.currentValue).not.toBe(NOT_FOUND);
      }
    }
  });
});
