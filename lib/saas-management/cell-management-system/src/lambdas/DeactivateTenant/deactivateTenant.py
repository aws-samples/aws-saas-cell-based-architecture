import json
import os
import boto3
import logging
from botocore.exceptions import ClientError
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

CELL_ROUTER_KVS_ARN = os.environ.get('CELL_ROUTER_KVS_ARN')

kvsClient = boto3.session.Session().client(
    'cloudfront-keyvaluestore',
    region_name='us-east-1',
    config=Config(tcp_keepalive=True,retries={'mode': 'adaptive'},signature_version='v4')
)

def delete_cell_routing_entry(tenantId):    
    try:
        logger.debug('removing config for tenant from KVS')

        # Get the current etag
        describe_response = kvsClient.describe_key_value_store(
            KvsARN=CELL_ROUTER_KVS_ARN
        )
        
        # Remvoe the routing information from KVS
        delete_response = kvsClient.delete_key(
            KvsARN=CELL_ROUTER_KVS_ARN,
            Key=tenantId,
            IfMatch=describe_response.get('ETag')
        )
        
    except ClientError as e:
        logger.error(f'Error persisting config object: {e}')
    except json.JSONDecodeError as e:
        logger.error(f'Error parsing config object: {e}')
    except Exception as e:
        logger.error(f'Unexpected Error persisting or parsing config object: {e}')

def handler(event, context):
     
    # Log the entire event
    logger.info('Received event: %s', event)

    # Extract the request body
    body = event.get('body')
    if body:
        try:
            data = json.loads(body)
            tenant_id = data.get('TenantId')
            delete_cell_routing_entry(tenant_id)
            logger.info('routing successfully removed for %s', tenant_id)
        except json.JSONDecodeError:
            logger.error('Invalid JSON in request body')
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON in request body'})
            }
    else:
        logger.info('No request body')

    # Process the request and generate a response
    response = {
        'statusCode': 200,
        'body': json.dumps({'TenantId': tenant_id, 'Status': "INACTIVE"})
    }

    # Log the response
    logger.info('Response: %s', response)
    return response