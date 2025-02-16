#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

## Import workshop configuration
# This contains the create_workshop() and delete_workshop() functions
FUNCTIONS=( _workshop-conf.sh _manage-workshop-stack.sh _workshop-shared-functions.sh )
for FUNCTION in "${FUNCTIONS[@]}"; do
    if [ -f $FUNCTION ]; then
        source $FUNCTION
    else
        echo "ERROR: $FUNCTION not found"
    fi
done

## Calls the create and delete operations
manage_workshop_stack() {
    create_workshop    
}

for i in {1..3}; do
    echo "iteration number: $i"
    if manage_workshop_stack; then
        echo "successfully completed execution"
        exit 0
    else
        sleep "$((15*i))"
    fi
done

echo "failed to complete execution"
exit 1
