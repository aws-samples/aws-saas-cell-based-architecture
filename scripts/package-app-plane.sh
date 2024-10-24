#!/bin/bash
CURRENT_DIR=${PWD}
APP_PLANE_ARCHIVE_DIR="$CURRENT_DIR/lib/application-plane"
APP_PLANE_ARCHIVE_FILENAME="cell-app-plane.zip"

if [ -f "$APP_PLANE_ARCHIVE_DIR/$APP_PLANE_ARCHIVE_FILENAME" ]; then
  echo "Removing existing $APP_PLANE_ARCHIVE_FILENAME"
  rm "$APP_PLANE_ARCHIVE_DIR/$APP_PLANE_ARCHIVE_FILENAME"
fi

cd $APP_PLANE_ARCHIVE_DIR/cell-app-plane
zip -r ../$APP_PLANE_ARCHIVE_FILENAME . -x ".git/*" -x "**/node_modules/*" -x "**/cdk.out/*"

cd $CURRENT_DIR
BUCKET_NAME=$(aws cloudformation describe-stacks --stack-name BridgeStack --query "Stacks[0].Outputs[?OutputKey=='S3SourceBucketName'].OutputValue" | jq -r '.[0]')
ZIP_FILE_NAME=$(aws s3api list-objects --bucket $BUCKET_NAME | jq -r '.Contents[0].Key')
echo "Current Directory: ${PWD}"
echo "Uploading $APP_PLANE_ARCHIVE_DIR/$APP_PLANE_ARCHIVE_FILENAME to $BUCKET_NAME"
aws s3 cp $APP_PLANE_ARCHIVE_DIR/$APP_PLANE_ARCHIVE_FILENAME s3://$BUCKET_NAME/$ZIP_FILE_NAME