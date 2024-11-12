#!/bin/bash

if [ $# -eq 6 ]; then
  echo "Deploying stack: $0 $CELL_ID $CELL_SIZE $TENANT_ID $TENANT_EMAIL $TENANT_LISTENER_PRIORITY $PRODUCT_IMAGE_VERSION"  
else
  echo "Need all six params: $0 <cellId> <cell_size> <tenantId> <tenant Email> <tenant listener priority> <product_image_Version>"
  exit 1
fi

CELL_ID=$1
CELL_SIZE=$2
TENANT_ID=$3
TENANT_EMAIL=$4
TENANT_LISTENER_PRIORITY=$5
PRODUCT_IMAGE_VERSION=$6

cd ../cdk
echo ${PWD}
echo Compiling TypeScript
npx tsc
echo Installing npm packages
npm install

echo Executing npm run build
npm run build

echo Executing cdk synth
cdk synth

echo Starting the deployment of CDK Stack

# Run the CDK deploy command with the correct parameters
npx cdk deploy "Cell-$CELL_ID-Tenant-$TENANT_ID" --app "npx ts-node bin/app.ts" \
  --context cellId="$CELL_ID" \
  --context cellSize="$CELL_SIZE" \
  --context tenantId="$TENANT_ID" \
  --context tenantEmail="$TENANT_EMAIL" \
  --context tenantListenerPriorityBase="$TENANT_LISTENER_PRIORITY" \
  --context productImageVersion="$PRODUCT_IMAGE_VERSION" \
  --no-staging \
  --require-approval never \
  --concurrency 10 \
  --asset-parallelism true \
  --outputs-file tenant_stack_outputs.json

if [ -s tenant_stack_outputs.json ]; then
  filesize=$(stat -c%s tenant_stack_outputs.json)
  if [ $filesize -gt 5 ]; then
    echo CDK deploy ran successfully and wrote stack outputs to file, exiting cleanly
    echo "CONTENTS OF tenant_stack_outputs.json:"
    cat tenant_stack_outputs.json
    ls -lh
  else
    echo CDK deploy ended without outputs being written to file, exiting with an error code
    echo "CONTENTS OF tenant_stack_outputs.json:"
    cat tenant_stack_outputs.json
    ls -lh
    exit 1
  fi
else
  echo CDK deploy ended without outputs file being created at all, so exiting with an error code
  exit 1
fi

cd ../scripts