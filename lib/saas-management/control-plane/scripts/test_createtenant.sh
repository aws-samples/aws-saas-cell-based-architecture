#!/bin/bash -e

if [ -z "$1" ]; then
  echo "Usage: $0 <cellId> <tenantName> <tenantEmail> <tenantTier>"
  exit 1
fi

if [ -z "$2" ]; then
  echo "Usage: $1 <cellId> <tenantName> <tenantEmail> <tenantTier>"
  exit 1
fi

if [ -z "$3" ]; then
  echo "Usage: $0 <cellId> <tenantName> <tenantEmail> <tenantTier>"
  exit 1
fi

if [ -z "$4" ]; then
  echo "Usage: $0 <cellId> <tenantName> <tenantEmail> <tenantTier>"
  exit 1
fi


CELL_ID=$1
TENANT_NAME=$2
TENANT_EMAIL=$3
TENANT_TIER=$4

echo "Deploying tenant $TENANT_NAME in cell $CELL_ID"

CONTROL_PLANE_STACK_NAME="ControlPlaneStack"

USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name $CONTROL_PLANE_STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" | jq -r '.[0]')
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $CONTROL_PLANE_STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" | jq -r '.[0]')

USER="admin"
PASSWORD="#CellBased1234"

echo "CLIENT_ID: ${CLIENT_ID}"
echo "USER_POOL_ID: ${USER_POOL_ID}"

# required in order to initiate-auth
UPDATE_USER_POOL_AUTH=$(aws cognito-idp update-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-id "$CLIENT_ID" \
    --explicit-auth-flows USER_PASSWORD_AUTH)

# check if user exists
DATA=$((aws cognito-idp list-users \
    --user-pool-id "$USER_POOL_ID" \
    --filter "username = \"$USER\"" \
    --output json
) | jq -r '.Users[0].Username')
echo "DATA: ${DATA}"

if [ "$DATA" != "$USER" ]; then
    # create user
    CREATE_ADMIN=$(aws cognito-idp admin-create-user \
        --user-pool-id "$USER_POOL_ID" \
        --username "$USER" )
        

    # remove need for password reset
    SET_PASSWORD=$(aws cognito-idp admin-set-user-password \
        --user-pool-id "$USER_POOL_ID" \
        --username "$USER" \
        --password "$PASSWORD" \
        --permanent)
fi

# get credentials for user
AUTHENTICATION_RESULT=$(aws cognito-idp initiate-auth \
    --auth-flow USER_PASSWORD_AUTH \
    --client-id "${CLIENT_ID}" \
    --auth-parameters "USERNAME=${USER},PASSWORD='${PASSWORD}'" \
    --query 'AuthenticationResult')

ID_TOKEN=$(echo "$AUTHENTICATION_RESULT" | jq -r '.IdToken')
echo "ID_TOKEN: ${ID_TOKEN}"


CONTROL_PLANE_API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$CONTROL_PLANE_STACK_NAME" \
    --query "Stacks[0].Outputs[?contains(OutputKey,'ControlPlaneApiEndpoint')].OutputValue" \
    --output text)
echo "CONTROL_PLANE_API_ENDPOINT: ${CONTROL_PLANE_API_ENDPOINT}"

# echo "creating tenant..."

TENANT_ID=$(curl --request POST \
    --url "${CONTROL_PLANE_API_ENDPOINT}CellControlPlaneApi/AssignTenantToCell" \
    --header "Authorization: Bearer ${ID_TOKEN}" \
    --header 'content-type: application/json' \
    --data "{\"CellId\":\"$CELL_ID\",\"TenantName\":\"$TENANT_NAME\",\"TenantEmail\": \"$TENANT_EMAIL\",\"TenantTier\":\"$TENANT_TIER\"}" \
    | jq -r '.TenantId')

echo "TENANT ID: ${TENANT_ID}"



