#!/bin/bash

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

CURRENT_DIR=${PWD}
APP_PLANE_ARCHIVE_DIR="$CURRENT_DIR/lib/application-plane"
APP_PLANE_ARCHIVE_FILENAME="cell-app-plane.zip"

if [ -f "$APP_PLANE_ARCHIVE_DIR/$APP_PLANE_ARCHIVE_FILENAME" ]; then
  echo -e "${YELLOW}Removing existing${NC} $APP_PLANE_ARCHIVE_FILENAME"
  rm "$APP_PLANE_ARCHIVE_DIR/$APP_PLANE_ARCHIVE_FILENAME"
fi

echo -e "${YELLOW}Creating a .zip package of the python code${NC}"
cd $APP_PLANE_ARCHIVE_DIR/cell-app-plane
zip -r ../$APP_PLANE_ARCHIVE_FILENAME . -x ".git/*" -x "**/node_modules/*" -x "**/cdk.out/*"

cd $CURRENT_DIR
BUCKET_NAME=$(aws cloudformation describe-stacks --stack-name Bridge --query "Stacks[0].Outputs[?OutputKey=='S3SourceBucketName'].OutputValue" | jq -r '.[0]')
ZIP_FILE_NAME=$(aws s3api list-objects --bucket $BUCKET_NAME | jq -r '.Contents[0].Key')
echo -e "${YELLOW}Current Directory:${NC} ${PWD}"
echo -e "${YELLOW}Uploading${NC} $APP_PLANE_ARCHIVE_DIR/$APP_PLANE_ARCHIVE_FILENAME to $BUCKET_NAME"
aws s3 cp $APP_PLANE_ARCHIVE_DIR/$APP_PLANE_ARCHIVE_FILENAME s3://$BUCKET_NAME/$ZIP_FILE_NAME
echo -e "${GREEN}Upload complete, go to the AWS CodePipeline console to track progress:${NC} https://us-east-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/CellDeploymentStateMachine/view?region=us-east-1"
