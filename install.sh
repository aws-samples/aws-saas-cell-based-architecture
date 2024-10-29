#!/bin/bash -e

EMAIL="user@awssaascellworkshop.com"

#need the empty file for the build to pass. We recreate this file during package step later
touch lib/application-plane/cell-app-plane.zip

# Deploy the solution
./scripts/deploy.sh

# Create a new cell with free tier
./scripts/test_createcell.sh freetier S 1
CELL_ID=$(cat cell_id.txt)
echo "Cell ID: $CELL_ID"

# Create a new tenant with in that cell
./scripts/test_createtenant.sh $CELL_ID firsttenant $EMAIL free
TENANT_ID=$(cat tenant_id.txt)
echo "Tenant ID: $TENANT_ID"

# Activate the tenant
./scripts/test_activatetenant.sh $CELL_ID $TENANT_ID