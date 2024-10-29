
import base64
import json
import os
import boto3
import logging

dynamodb = boto3.resource('dynamodb')

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
     
    # Log the entire event
    logger.info('Received event: %s', event)

    # Extract the request body
    queryParams = event.get('queryStringParameters')
    if queryParams:
        try:
            cellId = queryParams.get('CellId')
            tenantId = queryParams.get('TenantId')
            logger.info('CellId: %s', cellId)
            logger.info('TenantId: %s', tenantId)
        except json.JSONDecodeError:
            logger.error('Invalid JSON in request body')
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON in request body'})
            }
        else:
            return describe_tenant(cellId, tenantId)
    else:
        logger.info('No TenantId found!')

    # Process the request and generate a response
    response = {
        'statusCode': 200,
        'body': json.dumps({'message': 'This is a response from the DescribeTenant Lambda!'})
    }

    # Log the response
    logger.info('Response: %s', response)

    return response

def describe_tenant(cell_id, tenant_id):

        tenant_management_table = os.environ.get('TENANT_MANAGEMENT_TABLE')
        ddb_table = dynamodb.Table(tenant_management_table)
        try:
            ddb_response = ddb_table.get_item(
                Key={
                    'PK': cell_id + "#" + tenant_id
                }
            )
        except Exception as e:
            logger.error(f"Error retrieving tenant status: {str(e)}")
            return {
                'statusCode': 500,
                'body': json.dumps('Error retrieving tenant status')
            }
        
        if 'Item' in ddb_response:
            item = ddb_response['Item']
            tenant_id = item.get('tenant_id')
            cell_id = item.get('cell_id')
            tenant_name = item.get('tenant_name')
            tenant_status = item.get('current_status')
            tenant_tier = item.get('tenant_tier')
            tenant_email = item.get('tenant_email'),
            tenant_listener_priority = item.get('tenant_listener_priority')
                                                                                
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'CellId': cell_id,
                    'TenantId': tenant_id,
                    'TenantName': tenant_name,
                    'Status': tenant_status,
                    'TenantTier': tenant_tier,
                    'TenantEmail': tenant_email,
                    'TenantListenerPriority': tenant_listener_priority
                })
            }
        
        else:
            return {
                'statusCode': 404,
                'body': json.dumps(f'Tenant not found: {cell_id} & {tenant_id}')
            }