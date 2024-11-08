#!/bin/bash

#need the empty file for the build to pass. We recreate this file during package the step
touch lib/application-plane/cell-app-plane.zip

npm install
npx cdk bootstrap
cdk deploy Bridge --require-approval never
source "${PWD}/scripts/package-app-plane.sh"
cdk deploy CommonObservability CellRouter CellManagementSystem CellProvisioningSystem --require-approval never
CODE_BUILD=$(aws codebuild start-build --project-name SaasProductServiceBuildProject)