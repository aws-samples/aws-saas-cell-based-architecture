#!/bin/bash

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
        --duration)
            DURATION="$2"
            shift 2
            ;;
        *)
            echo "${RED}Unknown parameter: $1${NC}"
            echo "${YELLOW}Usage: $0 --cell-id <cell_id> --duration <duration_in_seconds>${NC}"
            exit 1
            ;;
    esac
done

# Check if required parameters are provided
if [ -z "$CELL_ID" ] || [ -z "$DURATION" ]; then
    echo "${RED}Missing required parameters${NC}"
    echo "${YELLOW}Usage: $0 --cell-id <cell_id> --duration <duration_in_seconds>${NC}"
    exit 1
fi

# Retrieve VPC ID that starts with the cell-id prefix
vpc_id=$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=Cell-${CELL_ID}*" --query "Vpcs[0].VpcId" --output text)

if [ -z "$vpc_id" ] || [ "$vpc_id" == "None" ]; then
    echo "${RED}No VPC found with cell-id prefix '${CELL_ID}'${NC}"
    exit 1
fi

echo "${YELLOW}Found VPC: $vpc_id${NC}"

# Retrieve the default NACL for the VPC
nacl_id=$(aws ec2 describe-network-acls --filters "Name=vpc-id,Values=${vpc_id}" "Name=default,Values=true" --query "NetworkAcls[0].NetworkAclId" --output text)

if [ -z "$nacl_id" ] || [ "$nacl_id" == "None" ]; then
    echo "${RED}No default NACL found for VPC ${vpc_id}${NC}"
    exit 1
fi

echo "${YELLOW}Found NACL: $nacl_id${NC}"

# Function to add a deny rule
add_deny_rule() {
    local rule_number=$1
    local cidr_block=$2
    
    aws ec2 create-network-acl-entry \
        --network-acl-id $nacl_id \
        --rule-number $rule_number \
        --protocol -1 \
        --rule-action deny \
        --egress \
        --cidr-block $cidr_block

    echo "${GREEN}Added deny rules for $cidr_block${NC}"
}

# Function to delete a deny rule
delete_deny_rule() {
    local rule_number=$1
    
    aws ec2 delete-network-acl-entry \
        --network-acl-id $nacl_id \
        --rule-number $rule_number\
        --egress

    echo "${GREEN}Deleted deny rules for rule number $rule_number${NC}"
}

# Add deny rules
add_deny_rule 90 "3.236.94.0/24"
add_deny_rule 91 "44.202.79.0/24"

echo "${YELLOW}NACL update complete${NC}"

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

# Display countdown timer for the specified duration
display_countdown

echo "${YELLOW}Experiment completed, NACL rule rollback started${NC}"

# Delete deny rules
delete_deny_rule 90
delete_deny_rule 91

echo "${GREEN}Experiment completed. NACL rules rollback complete.${NC}"
