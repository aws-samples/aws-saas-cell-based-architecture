#!/bin/bash

# Color definitions
RED='\033[0;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Define CloudWatch logs domains to block with region placeholder
declare -a DOMAINS
DOMAINS[60]="logs.REGION.amazonaws.com"
DOMAINS[80]="logs.REGION.api.aws"

# Initialize arrays
declare -a CELL_IDS

# Store Rule numbers and NACL IDs for cleanup
declare -a RULE_NUMBERS
declare -A NACL_IDS

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --cell-ids)
            IFS=',' read -ra CELL_IDS <<< "$2"
            shift 2
            ;;
        --duration)
            DURATION="$2"
            shift 2
            ;;
        --region)
            REGION="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown parameter: $1${NC}"
            echo -e "${YELLOW}Usage: $0 --cell-ids <cell_id1,cell_id2,...> --duration <duration_in_seconds> --region <aws_region>${NC}"
            exit 1
            ;;
    esac
done

# Check if required parameters are provided
if [ ${#CELL_IDS[@]} -eq 0 ] || [ -z "$DURATION" ] || [ -z "$REGION" ]; then
    echo -e "${RED}Missing required parameters${NC}"
    echo -e "${YELLOW}Usage: $0 --cell-ids <cell_id1,cell_id2,...> --duration <duration_in_seconds> --region <aws_region>${NC}"
    exit 1
fi

# Validate region
if ! aws ec2 describe-regions --region-names "$REGION" &>/dev/null; then
    echo -e "${RED}Invalid AWS region: $REGION${NC}"
    exit 1
fi

# Export AWS_DEFAULT_REGION for AWS CLI commands
export AWS_DEFAULT_REGION="$REGION"

# Function to check if value exists in array
contains_element() {
    local element="$1"
    local array=("${@:2}")
    for e in "${array[@]}"; do
        [[ "$e" == "$element" ]] && return 0
    done
    return 1
}

# Function to resolve DNS and get CIDR blocks
get_cidr_blocks() {
    local domain=$1
    local subnets_array=()

    echo -e "${BLUE}Resolving $domain${NC}" >&2
    local ips=($(dig +short "$domain"))
    
    if [ ${#ips[@]} -eq 0 ]; then
        echo -e "${RED}Failed to resolve IPs for $domain${NC}" >&2
        return 1
    fi
    
    # Process each IP and store unique subnets
    for ip in "${ips[@]}"; do
        # Get everything up to the last dot, then append .0/24
        subnet="${ip%.*}.0/24"
        # Only add if not already in array
        if ! contains_element "$subnet" "${subnets_array[@]}"; then
            subnets_array+=("$subnet")
        fi
    done

    printf '%s\n' "${subnets_array[@]}"
}

# Function to add deny rules for all IPs
add_deny_rules() {
    local nacl_id=$1
    local base_rule_number=$2
    local domain=$3
    local sub_rule=0
    
    echo -e "${BLUE}Adding deny rules for $domain${NC}"
    
    # Get all CIDR blocks for the domain
    local cidr_blocks=($(get_cidr_blocks "$domain"))
    if [ $? -ne 0 ]; then
        return 1
    fi
    
    for cidr_block in "${cidr_blocks[@]}"; do
        # Skip empty entries
        [ -z "$cidr_block" ] && continue
        
        local rule_number=$((base_rule_number + sub_rule))
        echo -e "${BLUE}Adding rule $rule_number for CIDR: $cidr_block${NC}"
        
        aws ec2 create-network-acl-entry \
            --network-acl-id "$nacl_id" \
            --rule-number "$rule_number" \
            --protocol -1 \
            --rule-action deny \
            --egress \
            --cidr-block "$cidr_block"

        if [ $? -eq 0 ]; then
            echo -e "${GREEN}Added deny rule for $domain ($cidr_block)${NC}"
            RULE_NUMBERS["${rule_number}"]="$rule_number"
            ((sub_rule++))
        else
            echo -e "${RED}Failed to add deny rule for $domain ($cidr_block)${NC}"
        fi
    done
}

revert_cell() {
    local cell_id=$1
    local nacl_id="${NACL_IDS[$cell_id]}"

    if [ -n "$nacl_id" ]; then
        echo -e "\n${YELLOW}Rolling back rules for Cell ${cell_id} on NACL ${nacl_id} ${NC}"
        for base_rule_number in "${!DOMAINS[@]}"; do
            domain="${DOMAINS[$base_rule_number]}"
            domain="${domain/REGION/$REGION}"
            delete_deny_rules "$nacl_id" "$base_rule_number" "$domain"
        done
    fi
}

delete_deny_rules() {
    local nacl_id=$1
    local base_rule_number=$2
    local domain=$3
    local sub_rule=0
    
    echo -e "${BLUE}Deleting deny rules for $nacl_id and $domain${NC}"
    
    # Get all CIDR blocks for the domain
    local cidr_blocks=($(get_cidr_blocks "$domain"))
    if [ $? -ne 0 ]; then
        return 1
    fi
    
    for cidr_block in "${cidr_blocks[@]}"; do
        # Skip empty entries
        [ -z "$cidr_block" ] && continue
        
        local rule_number=$((base_rule_number + sub_rule))
        echo -e "${BLUE}Deleting rule $rule_number for CIDR: $cidr_block${NC}"
        
        aws ec2 delete-network-acl-entry \
            --network-acl-id "$nacl_id" \
            --rule-number "$rule_number" \
            --egress

        if [ $? -eq 0 ]; then
            echo -e "${GREEN}Deleted deny rule for $domain ($cidr_block)${NC}"
            #RULE_NUMBERS["${rule_number}"]="$rule_number"
            ((sub_rule++))
        else
            echo -e "${RED}Failed to delete deny rule for $domain ($cidr_block)${NC}"
        fi
    done
}

# Function to process a single cell
process_cell() {
    local cell_id=$1
    local vpc_id
    local nacl_id

    echo -e "\n${YELLOW}Processing Cell: ${cell_id} in region ${REGION}${NC}"

    # Retrieve VPC ID that starts with the cell-id prefix
    vpc_id=$(aws ec2 describe-vpcs \
        --filters "Name=tag:Name,Values=Cell-${cell_id}*" \
        --query "Vpcs[0].VpcId" \
        --output text)

    if [ -z "$vpc_id" ] || [ "$vpc_id" == "None" ]; then
        echo -e "${RED}No VPC found with cell-id prefix '${cell_id}' in region ${REGION}${NC}"
        return 1
    fi

    echo -e "${YELLOW}Found VPC: $vpc_id${NC}"

    # Retrieve the default NACL for the VPC
    nacl_id=$(aws ec2 describe-network-acls \
        --filters "Name=vpc-id,Values=${vpc_id}" "Name=default,Values=true" \
        --query "NetworkAcls[0].NetworkAclId" \
        --output text)

    if [ -z "$nacl_id" ] || [ "$nacl_id" == "None" ]; then
        echo -e "${RED}No default NACL found for VPC ${vpc_id}${NC}"
        return 1
    fi

    echo -e "${YELLOW}Found NACL: $nacl_id${NC}"

    # Add deny rules for this cell
    for base_rule_number in "${!DOMAINS[@]}"; do
        domain="${DOMAINS[$base_rule_number]}"
        domain="${domain/REGION/$REGION}"
        add_deny_rules "$nacl_id" "$base_rule_number" "$domain"
    done

    # Store NACL ID for later cleanup
    NACL_IDS["$cell_id"]="$nacl_id"
}

# Apply the blocks for each cell
process_cells() {
    # Process each cell
    for cell_id in "${CELL_IDS[@]}"; do
        process_cell "$cell_id"
    done
}

# Update the cleanup and rollback code
cleanup() {
    echo -e "\n${YELLOW}Cleaning up NACL rules...${NC}"
    for cell_id in "${CELL_IDS[@]}"; do
        revert_cell "$cell_id"
    done
    echo -e "\n${GREEN}Cleanup completed${NC}"
    exit 0
}

# Function to display countdown timer
display_countdown() {
    local remaining=$DURATION
    while [ $remaining -gt 0 ]; do
        printf "\r${YELLOW}Experiment in progress. Time remaining: %02d:%02d${NC}" $((remaining/60)) $((remaining%60))
        sleep 1
        remaining=$((remaining-1))
    done
    printf "\n"
}

# Set up trap for cleanup on script interruption
trap cleanup SIGINT SIGTERM

process_cells

echo -e "\n${YELLOW}NACL updates complete${NC}"

# Display countdown timer for the specified duration
display_countdown

echo -e "${YELLOW}Experiment completed, NACL rule rollback started${NC}"

cleanup

echo -e "${GREEN}Experiment completed. All NACL rules rollback complete.${NC}"
