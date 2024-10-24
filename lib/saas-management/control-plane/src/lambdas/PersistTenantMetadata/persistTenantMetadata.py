
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

    # Extract the request body
    detail = event.get('detail')
    if detail:
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
    else:
        logger.info('Wrong request body')
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'Wrong request body'})
        }

    cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
    ddb_table = dynamodb.Table(cell_management_table)

    stack_name = "Cell-" + detail.get("CELL_ID") + "-Tenant-" + detail.get("TENANT_ID")
    stack_outputs = json.loads(detail.get("STACK_OUTPUTS"))
    cloudformation_outputs = stack_outputs[stack_name]

    response = ddb_table.update_item(
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