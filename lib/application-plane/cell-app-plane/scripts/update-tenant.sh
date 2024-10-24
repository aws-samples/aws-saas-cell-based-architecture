#!/bin/bash

CELL_ID=$1
TENANT_ID=$2
TENANT_EMAIL=$3

# Ensure a cell ID, tenant ID and tenant Email are provided
if [ $# -eq 3 ]; then
  echo "Deploying stack: $0 $CELL_ID $TENANT_ID $TENANT_EMAIL"  
else
  echo "Need all three params: $0 <cellId> <tenantId> <tenant Email>"
  exit 1
fi

cd ../cdk
echo ${PWD}
npx tsc
npm install
npm run build
cdk synth

# Run the CDK deploy command with the correct parameters
npx cdk deploy "Cell-$CELL_ID-Tenant-$TENANT_ID"  --app "npx ts-node bin/app.ts" \
  -c cellId="$CELL_ID" \
  -c tenantId="$TENANT_ID" \
  -c tenantEmail="$TENANT_EMAIL" \
  --no-staging \
  --require-approval never \
  --concurrency 10 \
  --asset-parallelism true


# chmod +x deploy-tenants.sh 
#./deploy-tenants.sh tenant11
#./deploy-tenants.sh tenant21