#!/bin/bash -e

# Ensure a cell ID, tenant ID and tenant Email are provided
if [ $# -ge 2 ]; then
  echo "Usage: $0 <cellId> <tenantId>"  
else
  echo "Usage: $0 <cellId> <tenantId>"
  exit 1
fi

CELL_ID=$1
TENANT_ID=$2

CELL_STACK_NAME="Cell-$CELL_ID"

CELL_ROUTER_STACK="CellRouter"

USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name $CELL_STACK_NAME --query "Stacks[0].Outputs[?ExportName=='CellUserPoolId-$CELL_ID'].OutputValue" | jq -r '.[0]')
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $CELL_STACK_NAME --query "Stacks[0].Outputs[?ExportName=='CellAppClientId-$CELL_ID'].OutputValue" | jq -r '.[0]')

USER="tenantadmin-$TENANT_ID"
PASSWORD="#SaaSCellArchitecutre1234"

echo "CLIENT_ID: ${CLIENT_ID}"
echo "USER_POOL_ID: ${USER_POOL_ID}"

# required in order to initiate-auth
UPDATE_AUTH_FLOW=$(aws cognito-idp update-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-id "$CLIENT_ID" \
    --explicit-auth-flows USER_PASSWORD_AUTH)

# remove need for password reset
UPDATE_PWD=$(aws cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$USER" \
    --password "$PASSWORD" \
    --permanent)

# get credentials for user
AUTHENTICATION_RESULT=$(aws cognito-idp initiate-auth \
    --auth-flow USER_PASSWORD_AUTH \
    --client-id "${CLIENT_ID}" \
    --auth-parameters "USERNAME=${USER},PASSWORD='${PASSWORD}'" \
    --query 'AuthenticationResult')

ID_TOKEN=$(echo "$AUTHENTICATION_RESULT" | jq -r '.IdToken')
echo "ID_TOKEN: ${ID_TOKEN}"

ROUTER_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$CELL_ROUTER_STACK" \
    --query "Stacks[0].Outputs[?contains(OutputKey,'DistributionUrl')].OutputValue" \
    --output text)
echo "ROUTER_ENDPOINT: ${ROUTER_ENDPOINT}"

PRODUCT_ID=$RANDOM
echo $PRODUCT_ID

DATA=$(jq --null-input \
    --arg productId "$PRODUCT_ID" \
    '{
        "productId": $productId,
        "productName": "test product",
        "productDescription": "test product",
        "productPrice": 20
    }'
)

curl --request POST \
    --url "https://${ROUTER_ENDPOINT}/product/" \
    --header "Authorization: Bearer ${ID_TOKEN}" \
    --header 'content-type: application/json' \
    --header "tenantid: ${TENANT_ID}" \
    --data "$DATA"

RESPONSE=$(curl "https://${ROUTER_ENDPOINT}/product/" \
    -H "Authorization: Bearer ${ID_TOKEN}" \
    -H 'content-type: application/json' \
    -H "tenantid: ${TENANT_ID}")

echo "RESPONSE: ${RESPONSE}"

echo "" # add newline    

             
