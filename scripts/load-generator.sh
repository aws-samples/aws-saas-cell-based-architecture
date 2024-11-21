#!/bin/bash

# Default values
DEFAULT_DURATION=60

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'

NC='\033[0m' # No Color

# Initialize arrays
declare -a CELL_IDS
declare -a TENANT_IDS
declare -a ID_TOKENS
declare -a SUCCESS_COUNTS
declare -a FAILED_4XX_COUNTS
declare -a FAILED_5XX_COUNTS
declare -a LAST_RESPONSES

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --cell-ids)
            IFS=',' read -ra CELL_IDS <<< "$2"
            shift 2
            ;;
        --tenant-ids)
            IFS=',' read -ra TENANT_IDS <<< "$2"
            shift 2
            ;;
        --duration)
            DURATION="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown parameter: $1${NC}"
            echo -e "${YELLOW}Usage: $0 --cell-ids <cell_id1,cell_id2,...> --tenant-ids <tenant_id1,tenant_id2,...> --duration <seconds>${NC}"
            exit 1
            ;;
    esac
done

# Validation checks
if [ ${#CELL_IDS[@]} -eq 0 ]; then
    echo -e "${RED}Error: No cell IDs provided${NC}"
    exit 1
fi

if [ ${#TENANT_IDS[@]} -eq 0 ]; then
    echo -e "${RED}Error: No tenant IDs provided${NC}"
    exit 1
fi

if [ ${#CELL_IDS[@]} -ne ${#TENANT_IDS[@]} ]; then
    echo -e "${RED}Error: Number of cell IDs must match number of tenant IDs${NC}"
    exit 1
fi

# Set default values if not provided
DURATION=${DURATION:-$DEFAULT_DURATION}

# Function to draw table header
draw_table_header() {
    echo -e "\n┌────────────┬────────────┬────────────┬────────────┬────────────┐"
    echo -e "│  ${BLUE}Cell ID${NC}   │ ${BLUE}Tenat ID${NC}   | ${GREEN}Successful${NC} │   ${YELLOW}4XX${NC}      │   ${RED}5XX${NC}      │"
    echo -e "├────────────┼────────────┼────────────┼────────────┼────────────┤"
}

# Function to draw table row
draw_table_row() {
    local cell_id=$1
    local tenant_id=$2
    local i=$3
    local success=${SUCCESS_COUNTS[$i]}
    local failed_4xx=${FAILED_4XX_COUNTS[$i]}
    local failed_5xx=${FAILED_5XX_COUNTS[$i]}
    local last_response="${LAST_RESPONSES[$i]:-N/A}"
    
    # Truncate last response to fit in column
    last_response="${last_response:0:24}"
    
    printf "│ %-10s │ %-10s │ %10d │ %10d │ %10d │\n" \
        "$cell_id" "$tenant_id" "$success" "$failed_4xx" "$failed_5xx"
}

# Function to draw table footer
draw_table_footer() {
    echo -e "└────────────┴────────────┴────────────┴────────────┴────────────┘"
}

# Function to prepare login for a cell-tenant pair
prepare_login() {
    local cell_id=$1
    local tenant_id=$2
    
    # Retrieve the USER_POOL_ID of the cell
    local user_pool_id=$(aws cloudformation describe-stacks --stack-name Cell-${cell_id} \
        --query "Stacks[0].Outputs[?OutputKey=='CellUserPoolId'].OutputValue" | jq -r '.[0]')
    
    # Retrieve the USER_POOL_CLIENT_ID of the cell
    local user_pool_client_id=$(aws cloudformation describe-stacks --stack-name Cell-${cell_id} \
        --query "Stacks[0].Outputs[?OutputKey=='CellAppClientId'].OutputValue" | jq -r '.[0]')
    
    # Set the password on Cognito
    aws cognito-idp admin-set-user-password \
        --user-pool-id "${user_pool_id}" \
        --username "tenantadmin-${tenant_id}" \
        --password "tenat@AdminPass1" \
        --permanent
    
    # Login and get token
    local id_token=$(aws cognito-idp initiate-auth \
        --auth-flow USER_PASSWORD_AUTH \
        --client-id "${user_pool_client_id}" \
        --auth-parameters "USERNAME=tenantadmin-${tenant_id},PASSWORD=tenat@AdminPass1" \
        --query 'AuthenticationResult' | jq -r '.IdToken')
    
    echo -e "${id_token}"
}

# Function to make the API call
make_request() {
    local id_token=$1
    local tenant_id=$2
    local distribution_url=$3
    
    local timestamp=$(date +%s | tail -c 7)
    local random=$((RANDOM % 1000))
    local product_id=$((timestamp * 1000 + random))

    local response=$(curl -s -w "\n%{http_code}" -X POST \
        --url "https://${distribution_url}/product" \
        -H "content-type: application/json" \
        -H "Authorization: Bearer ${id_token}" \
        -H "tenantId: ${tenant_id}" \
        -d "{\"productId\":\"${product_id}\",\"productName\":\"p${product_id}\",\"productDescription\":\"p${product_id}desc\",\"productPrice\":\"10\"}")
    
    local body=$(echo -e "$response" | sed '$d')
    local http_code=$(echo -e "$response" | tail -n1)
    echo -e "$http_code|$body"
}

# Display the configuration
echo -e "${YELLOW}Running with configuration:${NC}"
echo -e "${GREEN}Cell IDs: ${CELL_IDS[*]}${NC}"
echo -e "${GREEN}Tenant IDs: ${TENANT_IDS[*]}${NC}"
echo -e "${GREEN}Duration: ${DURATION} seconds${NC}"

# Get distribution URL
DISTRIBUTION_URL=$(aws cloudformation describe-stacks --stack-name CellRouter \
    --query "Stacks[0].Outputs[?starts_with(OutputKey, 'DistributionUrl')].OutputValue" --output text)

echo -e "${YELLOW}The cell router URL: ${DISTRIBUTION_URL}${NC}"



# Prepare logins for all cell-tenant pairs
for i in "${!CELL_IDS[@]}"; do
    cell_id="${CELL_IDS[$i]}"
    tenant_id="${TENANT_IDS[$i]}"
    echo -e "${YELLOW}Preparing login for cell:${NC} ${cell_id} ${YELLOW}and tenant:${NC} ${tenant_id}"
    ID_TOKENS[$i]=$(prepare_login "$cell_id" "$tenant_id")
    echo -e "${GREEN}Login prepared successfully.${NC}"
    index=$cell_id$tenant_id
    SUCCESS_COUNTS[$i]=0
    FAILED_4XX_COUNTS[$i]=0
    FAILED_5XX_COUNTS[$i]=0
    LAST_RESPONSES[$i]="N/A"
done

# Calculate end time
END_TIME=$(($(date +%s) + DURATION))

    # Draw initial rows
    clear
    echo -e "${Blue}Test Progress:${NC}"
    draw_table_header
    for i in "${!CELL_IDS[@]}"; do
        cell_id="${CELL_IDS[$i]}"
        tenant_id="${TENANT_IDS[$i]}"
    draw_table_row "$cell_id" "$tenant_id"
    done
    draw_table_footer


# Main loop
while [ $(date +%s) -lt $END_TIME ]; do
    for i in "${!CELL_IDS[@]}"; do
        cell_id="${CELL_IDS[$i]}"
        tenant_id="${TENANT_IDS[$i]}"
        response=$(make_request "${ID_TOKENS[$i]}" "$tenant_id" "$DISTRIBUTION_URL")
        http_code=$(echo -e "$response" | head -n1 | cut -c1-3)
        response_body=$(echo -e "$response" | tail -n1 | cut -d'|' -f2)
        
        # Update counters
        if [[ "$http_code" -ge 200 ]] && [[ "$http_code" -lt 300 ]]; then
            ((SUCCESS_COUNTS[$i]++))
        elif [[ "$http_code" -ge 400 ]] && [[ "$http_code" -lt 500 ]]; then
            ((FAILED_4XX_COUNTS[$i]++))
        elif [[ "$http_code" -ge 500 ]]; then
            ((FAILED_5XX_COUNTS[$i]++))
        fi
        #Fetch the last response message for each cell and tenant combination. The code trims the first 60 characters only.
        LAST_RESPONSES[$i]=$(echo -e "${response_body}" | cut -c1-60)

    
    done
    clear
    echo -e "${BLUE}Test Progress:${NC}"
    draw_table_header
    for i in "${!CELL_IDS[@]}"; do
        cell_id="${CELL_IDS[$i]}"
        tenant_id="${TENANT_IDS[$i]}"
        draw_table_row "$cell_id" "$tenant_id" "$i"
    done
    draw_table_footer

    #Add the last response message for each entry. This is only valid when the --debug flag is passed. 
    for i in "${!CELL_IDS[@]}"; do
        cell_id="${CELL_IDS[$i]}"
        tenant_id="${TENANT_IDS[$i]}"
        echo -e "Last Response for Cell ID: ${cell_id} and Tenant ID: ${tenant_id}: ${LAST_RESPONSES[$i]}"
    done
    
done
