#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

## Defines workshop configuration shared amongst scripts

## Variables
REPO_URL="${REPO_URL:=https://github.com/aws-samples/aws-saas-cell-based-architecture}"
REPO_NAME="${REPO_NAME:=aws-saas-cell-based-architecture}"
REPO_BRANCH_NAME="${REPO_BRANCH_NAME:=main}"
TARGET_USER="participant"
HOME_FOLDER="Workshop"
DELAY=15 # Used to sleep in functions. Tweak as desired.
