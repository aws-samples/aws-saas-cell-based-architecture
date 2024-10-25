#!/bin/bash -e

if [ -z "$1" ]; then
  echo "Usage: $0 <cellName> <cellSize>"
  exit 1
fi

if [ -z "$2" ]; then
  echo "Usage: $0 <cellName> <cellSize>"
  exit 1
fi

CELL_NAME=$1
CELL_SIZE=$2
echo "Deploying Cell $CELL_NAME with Size $CELL_SIZE"

cd ../cdk
echo ${PWD}
echo Compiling TypeScript
npx tsc
echo Installing npm packages
npm install

echo Executing npm run build
npm run build

echo Executing cdk synth and bootstrap
cdk synth
npx cdk bootstrap

echo Starting the deployment of CDK Stack

# Executing the CellStack CDK stack to create ECS Cluster, ALB, S3 Bucket, ECR, Parameter Store, APIGW Resource
npx cdk deploy "Cell-$CELL_NAME" --app "npx ts-node bin/app.ts" \
  --context cellId="$CELL_NAME" \
  --context cellSize="$CELL_SIZE" \
  --require-approval never \
  --concurrency 10 \
  --asset-parallelism true \
  --outputs-file stack_outputs.json