#!/bin/bash
npm install
npm run build
npx cdk bootstrap
cdk deploy Bridge --require-approval never
source "${PWD}/scripts/package-app-plane.sh"
cdk deploy --all --require-approval never
CODE_BUILD=$(aws codebuild start-build --project-name SaasProductServiceBuildProject)