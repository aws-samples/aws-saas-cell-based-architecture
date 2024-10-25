#!/bin/bash

if [ $# -eq 5 ]; then
  echo "Deploying stack: $0 $CELL_ID $TENANT_ID $TENANT_EMAIL $TENANT_LISTENER_PRIORITY $PRODUCT_IMAGE_VERSION"  
else
  echo "Need all five params: $0 <cellId> <tenantId> <tenant Email> <tenant listener priority> <product_image_Version>"
  exit 1
fi

CELL_ID=$1
TENANT_ID=$2
TENANT_EMAIL=$3
TENANT_LISTENER_PRIORITY=$4
PRODUCT_IMAGE_VERSION=$5

cd ../cdk
echo ${PWD}
npx tsc
npm install
npm run build
cdk synth

# Run the CDK deploy command with the correct parameters
npx cdk deploy "Cell-$CELL_ID-Tenant-$TENANT_ID" --app "npx ts-node bin/app.ts" \
  -c cellId="$CELL_ID" \
  -c tenantId="$TENANT_ID" \
  -c tenantEmail="$TENANT_EMAIL" \
  -c tenantListenerPriorityBase="$TENANT_LISTENER_PRIORITY" \
  -c productImageVersion="$PRODUCT_IMAGE_VERSION" \
  --no-staging \
  --require-approval never \
  --concurrency 10 \
  --asset-parallelism true \
  --outputs-file tenant_stack_outputs.json

cd ../scripts