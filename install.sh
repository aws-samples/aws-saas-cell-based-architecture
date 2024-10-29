#!/bin/bash -e

EMAIL="user@awssaascellworkshop.com"

# Deploy the solution
./scripts/deploy.sh

# Create a new cell with free tier
./lib/saas-management/cell-management-system/scripts/test_createcell.sh freetier S 1
CELL_ID=$(cat cell_id.txt)
echo "Cell ID: $CELL_ID"

# Create a new tenant with in that cell
./lib/saas-management/cell-management-system/scripts/test_createtenant.sh $CELL_ID firsttenant $EMAIL free
TENANT_ID=$(cat tenant_id.txt)
echo "Tenant ID: $TENANT_ID"

# Activate the tenant
./lib/saas-management/cell-management-system/scripts/test_activatetenant.sh $CELL_ID $TENANT_ID