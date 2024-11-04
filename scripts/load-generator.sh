#!/bin/bash

# Default values
DEFAULT_DURATION=60

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --cell-id)
            CELL_ID="$2"
            shift 2
            ;;
        --tenant-id)
            TENANT_ID="$2"
            shift 2
            ;;
        --duration)
            DURATION="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown parameter: $1${NC}"
            echo -e "${YELLOW}Usage: $0 --cell-id <cell_id> --tenant-id <tenant_id> --duration <seconds>${NC}"
            exit 1
            ;;
    esac
done

# Check for missing mandatory parameters
missing_params=()
if [ -z "$CELL_ID" ]; then
    missing_params+=("--cell-id")
fi
if [ -z "$TENANT_ID" ]; then
    missing_params+=("--tenant-id")
fi

# If any mandatory parameters are missing, show error and exit
if [ ${#missing_params[@]} -ne 0 ]; then
    echo -e "${RED}Error: Missing required parameters: ${missing_params[*]}${NC}"
    echo -e "${YELLOW}Usage: $0 --cell-id <cell_id> --tenant-id <tenant_id> --duration <seconds>${NC}"
    exit 1
fi

# Set default values if not provided
DURATION=${DURATION:-$DEFAULT_DURATION}

# Display the configuration
echo -e "${YELLOW}Running with configuration:${NC}"
echo -e "${GREEN}Cell ID: ${CELL_ID}${NC}"
echo -e "${GREEN}Tenant ID: ${TENANT_ID}${NC}"
echo -e "${GREEN}Duration: ${DURATION} seconds${NC}"


# Prepare login
#retrieve the USER_POOL_ID OF THE CELL
export USER_POOL_ID_CELL=$(aws cloudformation describe-stacks --stack-name Cell-${CELL_ID} --query "Stacks[0].Outputs[?OutputKey=='CellUserPoolId'].OutputValue" | jq -r '.[0]')
#retrieve the USER_POOL_CLIENT_ID OF THE CELL
export USER_POOL_CLIENT_ID_CELL=$(aws cloudformation describe-stacks --stack-name Cell-${CELL_ID} --query "Stacks[0].Outputs[?OutputKey=='CellAppClientId'].OutputValue" | jq -r '.[0]')

#Set the password on Cognito
aws cognito-idp admin-set-user-password --user-pool-id  $USER_POOL_ID_CELL --username tenantadmin-${TENANT_ID} --password tenat@AdminPass1 --permanent

#Using both USER_POOL_ID_CELL and USER_POOL_CLIENT_ID_CELL to login using initiate-auth
export ID_TOKEN_CELL=$(aws cognito-idp initiate-auth \--auth-flow USER_PASSWORD_AUTH \
--client-id $USER_POOL_CLIENT_ID_CELL \
--auth-parameters "USERNAME=tenantadmin-${TENANT_ID},PASSWORD=tenat@AdminPass1" \
--query 'AuthenticationResult' | jq -r '.IdToken')

#Confirm that login is complete
echo -e "${GREEN}Login complete${NC}"

#retrieve the cell router cloudfront distribution url
export DISTRIBUTION_URL=$(aws cloudformation describe-stacks --stack-name CellRouter --query "Stacks[0].Outputs[?starts_with(OutputKey, 'DistributionUrl')].OutputValue" --output text)
echo -e "${YELLOW}The cell Distribution URL: ${DISTRIBUTION_URL}${NC}"

# Function to make the API call
make_request() {
local timestamp=$(date +%s | tail -c 7)
    local random=$((RANDOM % 1000))
    # Combine them ensuring it stays within PostgreSQL integer max value (2147483647)
    local product_id=$((timestamp * 1000 + random))
    curl -s -X POST \
        --url "https://${DISTRIBUTION_URL}/product" \
        -H "content-type: application/json" \
        -H "Authorization: Bearer $ID_TOKEN_CELL" \
        -H "tenantId: ${TENANT_ID}" \
        -d "{\"productId\":\"${product_id}\",\"productName\":\"p${product_id}\",\"productDescription\":\"p${product_id}desc\",\"productPrice\":\"10\"}"
}

# Calculate end time
END_TIME=$(($(date +%s) + DURATION))

# Counter for requests
counter=1

# Main loop
while [ $(date +%s) -lt $END_TIME ]; do
    make_request
    echo -e "${GREEN}Request $counter sent at $(date '+%H:%M:%S')${NC}"

    
    ((counter++))
done

echo -e "${YELLOW}Script completed. Total requests sent: $((counter-1))${NC}"


