#!/bin/bash

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse command line arguments
if [ -z "$2" ]; then
  echo -e "Usage: $0 --cell-id <cell_id>"
  exit 1
fi

CELL_ID="$2"

# Check if required parameters are provided
if [ -z "$CELL_ID" ] ; then
    echo -e "${RED}Missing required parameters${NC}"
    echo -e "${YELLOW}Usage: $0 --cell-id <cell_id>${NC}"
    exit 1
fi

# Retrieve VPC ID that starts with the cell-id prefix
vpc_id=$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=Cell-${CELL_ID}*" --query "Vpcs[0].VpcId" --output text)

if [ -z "$vpc_id" ] || [ "$vpc_id" == "None" ]; then
    echo -e "${RED}No VPC found with cell-id prefix '${CELL_ID}'${NC}"
    exit 1
fi

echo -e "${YELLOW}Found VPC: $vpc_id${NC}"

# Retrieve the default NACL for the VPC
nacl_id=$(aws ec2 describe-network-acls --filters "Name=vpc-id,Values=${vpc_id}" "Name=default,Values=true" --query "NetworkAcls[0].NetworkAclId" --output text)

if [ -z "$nacl_id" ] || [ "$nacl_id" == "None" ]; then
    echo -e "${RED}No default NACL found for VPC ${vpc_id}${NC}"
    exit 1
fi

echo -e "${YELLOW}Found NACL: $nacl_id${NC}"


# Function to delete a deny rule
delete_deny_rule() {
    local rule_number=$1
    
    aws ec2 delete-network-acl-entry \
        --network-acl-id $nacl_id \
        --rule-number $rule_number\
        --egress

    echo -e "${GREEN}Deleted deny rules for rule number $rule_number${NC}"
}


# Delete deny rules
delete_deny_rule 90
delete_deny_rule 91

echo -e "${GREEN}NACL rules rollback complete.${NC}"
