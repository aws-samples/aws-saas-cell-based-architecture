
import base64
import json
import os
import boto3
import logging
import json
import boto3

# Initialize clients
dynamodb = boto3.resource('dynamodb')

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
     
    # Log the entire event
    logger.info('Received event: %s', event)

    source = event.get("source")

    # Extract the request body
    detail = event.get('detail')
    if source == "cellManagement.tenantCreated":
        try:
            logger.info('details received: %s', json.dumps(detail))
            logger.info('CELL_ID: %s', detail.get("CELL_ID"))
            logger.info('TENANT_ID: %s', detail.get("TENANT_ID"))
            logger.info('STACK_OUTPUTS: %s', detail.get("STACK_OUTPUTS"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            logger.error('Invalid JSON or encoding in request body')
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON or encoding in request body'})
            }
    elif source == "cellManagement.tenantCreationError":
        try:
            logger.info('error details received: %s', json.dumps(detail))
            logger.info('CELL_ID: %s', detail.get("CELL_ID"))
            logger.info('TENANT_ID: %s', detail.get("TENANT_ID"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            logger.error('Invalid JSON or encoding in request body')
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON or encoding in request body'})
            }
    else:
        logger.info('Wrong request body')
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'Wrong request body'})
        }

    cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
    ddb_table = dynamodb.Table(cell_management_table)

    if source == "cellManagement.tenantCreated":
        stack_name = "Cell-" + detail.get("CELL_ID") + "-Tenant-" + detail.get("TENANT_ID")
        stack_outputs = json.loads(detail.get("STACK_OUTPUTS"))
        cloudformation_outputs = stack_outputs[stack_name]

        tenent_update_response = ddb_table.update_item(
            Key={
                'PK': detail.get("CELL_ID")+"#"+detail.get("TENANT_ID")
            },
            UpdateExpression="set current_status = :cs, cf_stack = :cfs, cf_metadata = :md",
            ExpressionAttributeValues={
                ':cs': 'available',
                ':cfs': stack_name,
                ':md': json.dumps(cloudformation_outputs)
            },
            ReturnValues="UPDATED_NEW"
        )
        return {
            'statusCode': 200,
            'body': json.dumps({'status': 'creating'})
        }
    else:
        stack_name = "Cell-" + detail.get("CELL_ID") + "-Tenant-" + detail.get("TENANT_ID")

        tenent_update_response = ddb_table.update_item(
            Key={
                'PK': detail.get("CELL_ID")+"#"+detail.get("TENANT_ID")
            },
            UpdateExpression="set current_status = :cs, cf_stack = :cfs",
            ExpressionAttributeValues={
                ':cs': 'failed',
                ':cfs': stack_name
            },
            ReturnValues="UPDATED_NEW"
        )

        try:
            ddb_response = ddb_table.get_item(
                Key={
                    'PK': detail.get("CELL_ID")
                }
            )
        except Exception as e:
            logger.error(f"Error retrieving cell status: {str(e)}")
            return {
                'statusCode': 500,
                'body': json.dumps('Error retrieving cell status')
            }

        if 'Item' in ddb_response:
            item = ddb_response['Item']
            cell_utilization = int(item.get('cell_utilization','0'))

        cell_update_response = ddb_table.update_item(
            Key={
                'PK': detail.get("CELL_ID")
            },
            UpdateExpression="set cell_utilization = :cu",
            ExpressionAttributeValues={
                ':cu': cell_utilization - 1
            },
            ReturnValues="UPDATED_NEW"
        )                          
        return {
            'statusCode': 200,
            'body': json.dumps({'status': 'tenant error processed'})
        }