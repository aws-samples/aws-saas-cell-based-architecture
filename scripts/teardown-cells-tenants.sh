#!/bin/bash
#
# Sequenced teardown of TENANTS -> CELLS + DynamoDB metadata cleanup.
#
# WHY THIS ORDER:
#   * Tenant stacks (Cell-<cell>-Tenant-<tenant>) import exports from the cell
#     stack, so CloudFormation blocks cell deletion until the tenant stacks are
#     gone -> delete all tenants of a cell BEFORE the cell.
#   * Deleting a tenant stack triggers its DE-PROVISION custom resource
#     (DROP DATABASE/USER in the cell's Aurora).
#   * DynamoDB rows are NOT removed by stack deletion (the control-plane table
#     survives), so each row is deleted explicitly here.
#   * DeactivateTenant removes the CloudFront KeyValueStore routing entry, which
#     stack deletion does NOT clean up.
#
# CAUTION:
#   * Destroys REAL infrastructure (Aurora, ECS, VPC, ALB, Cognito). Irreversible.
#   * RUN THIS BEFORE deploying the rds.py handler re-raise fix: the broken tenant
#     'etlgecv2e' has no DB role, so its DROP USER errors. The currently-deployed
#     Lambda swallows that (delete succeeds); the re-raise fix would block the
#     delete. (Or make tenant-de-provisioning.sql idempotent with IF EXISTS.)
#   * Does NOT delete the DynamoDB table or any control-plane stack.
#
# USAGE:
#   AWS_PROFILE=jonesaws+saas-Admin AWS_REGION=us-east-1 sh scripts/teardown-cells-tenants.sh
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
MGMT_STACK="CellManagementSystem"
# Workshop default admin password (same value already used by scripts/test_*.sh).
ADMIN_USER="admin"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-#CellBased1234}"

# Inventory to remove — CELL_ID:"TENANT_ID TENANT_ID ...". Pre-filled from the
# live scan on 2026-08-13; EDIT to match your intent, or pass entries as CLI
# args (e.g.  sh teardown-cells-tenants.sh "c864k22:ki43nd1gv").
CELLS=(
  "gad5884:etlgecv2e pzimq75os"
  "d9p5vvx:rdp63k4do"
)
# Optional CLI override: one or more  CELL_ID:"tenant tenant"  arguments.
if [ "$#" -gt 0 ]; then CELLS=("$@"); fi

TABLE=$(aws cloudformation list-stack-resources --stack-name "$MGMT_STACK" --region "$REGION" \
  --query "StackResourceSummaries[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" --output text)
API=$(aws cloudformation describe-stacks --stack-name "$MGMT_STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?contains(OutputKey,'CellManagementApiEndpoint')].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name "$MGMT_STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text)
TOKEN=$(aws cognito-idp initiate-auth --region "$REGION" --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" --auth-parameters "USERNAME=${ADMIN_USER},PASSWORD='${ADMIN_PASSWORD}'" \
  --query 'AuthenticationResult.IdToken' --output text)

delete_stack_and_wait() {
  local stack="$1"
  if aws cloudformation describe-stacks --stack-name "$stack" --region "$REGION" >/dev/null 2>&1; then
    echo "  deleting stack $stack ..."
    aws cloudformation delete-stack --stack-name "$stack" --region "$REGION"
    aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$REGION"
    echo "  $stack DELETE_COMPLETE"
  else
    echo "  stack $stack not found (skipping)"
  fi
}

ddb_delete() {
  echo "  removing DynamoDB row PK=$1"
  aws dynamodb delete-item --table-name "$TABLE" --region "$REGION" --key "{\"PK\":{\"S\":\"$1\"}}"
}

deactivate_tenant() {
  echo "  deactivating tenant $1 (remove CloudFront routing entry)"
  curl -s -X POST --url "${API}DeactivateTenant" \
    -H "content-type: application/json" -H "Authorization: Bearer ${TOKEN}" \
    -d "{\"TenantId\":\"$1\"}" >/dev/null || echo "  (deactivate returned non-zero; continuing)"
}

echo "Will tear down (tenants first, then cells):"
for e in "${CELLS[@]}"; do echo "  cell ${e%%:*}  <- tenants: ${e#*:}"; done
read -r -p "Type DELETE to proceed: " c; [ "$c" = "DELETE" ] || { echo "aborted"; exit 1; }

for e in "${CELLS[@]}"; do
  cell="${e%%:*}"; tenants="${e#*:}"
  echo "== Cell $cell: remove tenants =="
  for t in $tenants; do
    echo "- tenant $t"
    deactivate_tenant "$t"
    delete_stack_and_wait "Cell-${cell}-Tenant-${t}"
    ddb_delete "${cell}#${t}"
  done
  echo "== Cell $cell: remove cell =="
  delete_stack_and_wait "Cell-${cell}"
  ddb_delete "$cell"
done
echo "Teardown complete."
