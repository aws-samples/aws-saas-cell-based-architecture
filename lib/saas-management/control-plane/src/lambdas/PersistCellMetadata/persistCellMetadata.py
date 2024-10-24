
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
    if source == "cellManagement.cellCreated":
        try:
            logger.info('details received: %s', json.dumps(detail))
            logger.info('CELL_ID: %s', detail.get("CELL_ID"))
            logger.info('STACK_OUTPUTS: %s', detail.get("STACK_OUTPUTS"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            logger.error('Invalid JSON or encoding in request body')
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON or encoding in request body'})
            }
    elif source == "cellManagement.cellCreationError":
        try:
            logger.info('error details received: %s', json.dumps(detail))
            logger.info('CELL_ID: %s', detail.get("CELL_ID"))
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

    if source == "cellManagement.cellCreated":
        stack_name = "Cell-" + detail.get("CELL_ID")
        stack_outputs = json.loads(detail.get("STACK_OUTPUTS"))
        cloudformation_outputs = stack_outputs[stack_name]
        max_tenants_supported = int(cloudformation_outputs.get("CellTotalTenantsSupported"))
        cell_url = cloudformation_outputs.get("CellApiUrl")

        response = ddb_table.update_item(
            Key={
                'PK': detail.get("CELL_ID")
            },
            UpdateExpression="set current_status = :cs, cell_url = :cu, cell_max_capacity = :cmc, cf_stack = :cfs, cf_metadata = :cm",
            ExpressionAttributeValues={
                ':cs': 'available',
                ':cu': cell_url,
                ':cmc': max_tenants_supported,
                ':cfs': stack_name,
                ':cm': json.dumps(cloudformation_outputs)
            },
            ReturnValues="UPDATED_NEW"
        )
        return {
            'statusCode': 200,
            'body': json.dumps({'status': 'creating'})
        }
    else:
        stack_name = "Cell-" + detail.get("CELL_ID")
        response = ddb_table.update_item(
            Key={
                'PK': detail.get("CELL_ID")
            },
            UpdateExpression="set current_status = :cs, cf_stack = :cfs",
            ExpressionAttributeValues={
                ':cs': 'failed',
                ':cfs': stack_name
            },
            ReturnValues="UPDATED_NEW"
        )
        return {
            'statusCode': 200,
            'body': json.dumps({'status': 'error'})
        }