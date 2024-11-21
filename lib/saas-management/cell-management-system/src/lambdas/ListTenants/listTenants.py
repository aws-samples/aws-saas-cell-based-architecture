
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
    try:
        if 'queryStringParameters' in event and event['queryStringParameters'] is not None and 'CellId' in event['queryStringParameters']:
            cell_id = event['queryStringParameters']['CellId']
            logger.info('CellId: %s', cell_id)
            if cell_id is not None:
                return list_tenants(cell_id)
        else:
            logger.error('Invalid request parameters')
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON in request body'})
            }
    except Exception as e:
        logger.error("Couldn't scan for tenants: %s",e)
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'A Problem occurred listing tenants'})
        }

def list_tenants(cell_id):
    tenant_management_table = os.environ.get('TENANT_MANAGEMENT_TABLE')
    table = dynamodb.Table(tenant_management_table)
    tenants = []
    try:
        
        response = table.query(
            IndexName='TenantsByCellIdIndex',
            KeyConditionExpression='cell_id = :cell_id',
            ExpressionAttributeValues={
                ':cell_id': cell_id
            },
            ProjectionExpression='tenant_id, tenant_name, current_status'
        )

        if 'Items' in response:
            for item in response['Items']:
                tenant_id = item.get('tenant_id')
                tenant_name = item.get('tenant_name')
                tenant_status = item.get('current_status')
                                                                                    
                tenants.append({
                    'TenantId': tenant_id,
                    'TenantName': tenant_name,
                    'Status': tenant_status
                })
        
        return {
            'statusCode': 200,
            'body': json.dumps(tenants)
        }

    except Exception as e:
        logger.error("Couldn't scan for tenants: %s",e)
        raise

    # Process the request and generate a response
    response = {
        'statusCode': 200,
        'body': json.dumps(tenants)
    }
    return response