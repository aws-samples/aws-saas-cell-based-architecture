import base64
import json
import os
import boto3
import logging
from botocore.exceptions import ClientError
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BUCKET_NAME = os.environ.get('S3_BUCKET_NAME')
OBJECT_KEY = 'tenantToCellMapping.json'
DYNAMO_CELL_MANAGEMENT_TABLE = os.environ.get('CELL_MANAGEMENT_TABLE')

# Create an S3 client with keepalives to maximise performance
s3 = boto3.session.Session().client(
    's3', 
    region_name='us-east-1',
    config=Config(tcp_keepalive=True,retries={'mode': 'adaptive'})
)

dynamodb = boto3.resource('dynamodb')
ddb_table = dynamodb.Table(DYNAMO_CELL_MANAGEMENT_TABLE)

def get_config_map():
    
    try:
        logger.debug('Fetching config object from S3')
        # Get the object from S3
        response = s3.get_object(Bucket=BUCKET_NAME, Key=OBJECT_KEY)

        # Read and decode the object content
        object_content = response['Body'].read().decode('utf-8')
        
        # Parse the JSON and store it in the global variable
        mapping_data = json.loads(object_content)

    except ClientError as e:
        logger.error(f'Error retrieving config object: {e}')
        if e.response['Error']['Code'] == 'NoSuchKey':
            logger.info('No object found - returning empty dictionary')
            mapping_data = dict()
    except json.JSONDecodeError as e:
        logger.error(f'Error parsing config object: {e}')
    except Exception as e:
        logger.error(f'Unexpected Error retrieving or parsing config object: {e}')
    return mapping_data

def put_config_map(configMap):    
    try:
        logger.debug('writing config object to S3')
        # Get the object from S3
        response = s3.put_object(Bucket=BUCKET_NAME, Key=OBJECT_KEY, Body=json.dumps(configMap))
        
    except ClientError as e:
        logger.error(f'Error persisting config object: {e}')
    except json.JSONDecodeError as e:
        logger.error(f'Error parsing config object: {e}')
    except Exception as e:
        logger.error(f'Unexpected Error persisting or parsing config object: {e}')

def retrieve_cell_details(cell_id):

    try:
        response = ddb_table.get_item(
            Key={
                'PK': cell_id
            }
        )
        logger.debug(f"Response from DynamoDB: {response}")
    except Exception as e:
        logger.error(f"Error retrieving tenant status: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps('Error retrieving tenant status')
        }

    if 'Item' in response:
        item = response['Item']
        return item
    else:
        return {
            'statusCode': 404,
            'body': json.dumps(f'Cell not found: {cell_id}')
        }

def retrieve_tenant_details(cell_id,tenant_id):

    try:
        response = ddb_table.get_item(
            Key={
                'PK': cell_id+"#"+tenant_id
            }
        )
        logger.debug(f"Response from DynamoDB: {response}")
    except Exception as e:
        logger.error(f"Error retrieving tenant status: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps('Error retrieving tenant status')
        }

    if 'Item' in response:
        item = response['Item']
        return item
    else:
        return {
            'statusCode': 404,
            'body': json.dumps(f'Tenant ${tenant_id} not found in Cell {cell_id}')
        }
        
def handler(event, context):
     
    # Log the entire event
    logger.debug('Received event: %s', event)

    # Extract the request body
    body = event.get('body')
    if body:
        try:
            data = json.loads(body)
            tenant_id = data.get('TenantId')
            logger.debug('Tenant ID: %s', tenant_id)
            cell_id = data.get('CellId')
            logger.debug('Cell ID: %s', cell_id)
            
            cell_details = retrieve_cell_details(cell_id=cell_id)
            tenant_details = retrieve_tenant_details(cell_id=cell_id,tenant_id=tenant_id)

            logger.debug("retrieved cell details: %s", cell_details)
            logger.debug("retrieved tenant details: %s", tenant_details)

            if cell_details.get('current_status') == "available" and tenant_details.get('current_status') == "available":
                config_map = get_config_map()
                logger.debug('config map from s3: %s',json.dumps(config_map))
                config_map[tenant_id] = cell_details.get('cell_url')
                logger.debug('updated config map: %s',json.dumps(config_map))
                put_config_map(config_map)
                logger.debug('config map successfully written to s3')
            else:
                return {
                    'statusCode': 400,
                    'body': json.dumps({'error': 'Cell or Tenant is not available'}),
                }
        except json.JSONDecodeError:
            logger.error('Invalid JSON in request body')
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON in request body'})
            }
    else:
        logger.error('No request body')
        return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON in request body'})
            }

    # Process the request and generate a response
    response = {
        'statusCode': 200,
        'body': json.dumps({'TenantId': tenant_id, 'CellId': cell_id, 'Status': "ACTIVE"})
    }

    # Log the response
    logger.info('Response: %s', response)
    return response