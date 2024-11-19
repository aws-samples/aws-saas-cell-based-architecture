#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

create_workshop() {
    
    get_vscodeserver_id
    
    run_ssm_command "echo 'export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)' >> /home/${TARGET_USER}/.bashrc"
    run_ssm_command "cd /${HOME_FOLDER}/${REPO_NAME} && chmod +x install.sh && export UV_USE_IO_URING=0 && ./install.sh"
    run_ssm_command "chown -R ${TARGET_USER}:${TARGET_USER} /${HOME_FOLDER}"            

}
