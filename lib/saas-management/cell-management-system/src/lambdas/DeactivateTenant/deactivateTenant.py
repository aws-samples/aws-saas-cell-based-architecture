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

# Create an S3 client with keepalives to maximise performance
s3 = boto3.session.Session().client(
    's3', 
    region_name='us-east-1',
    config=Config(tcp_keepalive=True,retries={'mode': 'adaptive'})
)

def get_config_map():
    
    try:
        print('Fetching config object from S3')
        # Get the object from S3
        response = s3.get_object(Bucket=BUCKET_NAME, Key=OBJECT_KEY)

        # Read and decode the object content
        object_content = response['Body'].read().decode('utf-8')
        
        # Parse the JSON and store it in the global variable
        mapping_data = json.loads(object_content)

    except ClientError as e:
        print(f'Error retrieving config object: {e}')
        if e.response['Error']['Code'] == 'NoSuchKey':
            logger.info('No object found - returning empty dictionary')
            mapping_data = dict()
    except json.JSONDecodeError as e:
        print(f'Error parsing config object: {e}')
    except Exception as e:
        print(f'Unexpected Error retrieving or parsing config object: {e}')
    return mapping_data

def put_config_map(configMap):    
    try:
        print('writing config object to S3')
        # Get the object from S3
        response = s3.put_object(Bucket=BUCKET_NAME, Key=OBJECT_KEY, Body=json.dumps(configMap))
        
    except ClientError as e:
        print(f'Error persisting config object: {e}')
    except json.JSONDecodeError as e:
        print(f'Error parsing config object: {e}')
    except Exception as e:
        print(f'Unexpected Error persisting or parsing config object: {e}')

def handler(event, context):
     
    # Log the entire event
    logger.info('Received event: %s', event)

    # Extract the request body
    body = event.get('body')
    if body:
        try:
            data = json.loads(body)
            tenant_id = data.get('TenantId')
            config_map = get_config_map()
            logger.info('config map from s3: %s',json.dumps(config_map))
            del config_map[tenant_id]
            logger.info('updated config map: %s',json.dumps(config_map))
            put_config_map(config_map)
            logger.info('config map successfully written to s3')
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