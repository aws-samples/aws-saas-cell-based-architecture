#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Run an SSM command on an EC2 instance
run_ssm_command() {
    SSM_COMMAND="$1"
    parameters=$(jq -n --arg cm "runuser -l \"$TARGET_USER\" -c \"$SSM_COMMAND\"" '{executionTimeout:["3600"], commands: [$cm]}')
    comment=$(echo "$SSM_COMMAND" | cut -c1-100)
    # send ssm command to instance id in VSSERVER_ID
    sh_command_id=$(aws ssm send-command \
        --targets "Key=InstanceIds,Values=$VSSERVER_ID" \
        --document-name "AWS-RunShellScript" \
        --parameters "$parameters" \
        --cloud-watch-output-config "CloudWatchOutputEnabled=true,CloudWatchLogGroupName=workshopsetuplog" \
        --timeout-seconds 3600 \
        --comment "$comment" \
        --output text \
        --query "Command.CommandId")

    command_status="InProgress" # seed status var
    while [[ "$command_status" == "InProgress" || "$command_status" == "Pending" || "$command_status" == "Delayed" ]]; do
        sleep $DELAY
        command_invocation=$(aws ssm get-command-invocation \
            --command-id "$sh_command_id" \
            --instance-id "$VSSERVER_ID")
        # echo -E "$command_invocation" | jq # for debugging purposes
        command_status=$(echo -E "$command_invocation" | jq -r '.Status')
    done

    if [ "$command_status" != "Success" ]; then
        echo "failed executing $SSM_COMMAND : $command_status" && exit 1
    else
        echo "successfully completed execution!"
    fi
}

# Get vscodeserver instance ID
get_vscodeserver_id() {
    VSSERVER_ID=$(aws ec2 describe-instances \
        --filter "Name=tag:Name,Values=VSCodeServer" \
        --query 'Reservations[].Instances[].{Instance:InstanceId}' \
        --output text)
    
    echo "vscodeserver instance id: $VSSERVER_ID"
}
