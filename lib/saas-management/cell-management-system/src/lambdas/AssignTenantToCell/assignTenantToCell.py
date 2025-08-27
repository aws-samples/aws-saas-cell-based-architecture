import os
import logging
import json
import boto3
import string
import random
import re

# Initialize clients
eventbridge_client = boto3.client('events')
dynamodb = boto3.resource('dynamodb')
ssm_client = boto3.client('ssm')

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    # Log the entire event
    logger.info('Received event: %s', event)

    # Extract the request body
    body = event.get('body')
    if body:
        try:
            data = json.loads(body)
            logger.info('Request body: %s', data)

            # Get parameters from the request body
            cell_id = data.get('CellId')
            tenant_name = data.get('TenantName')
            tenant_tier = data.get('TenantTier')
            tenant_email = data.get('TenantEmail')

            email_regex = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b'
            if(re.fullmatch(email_regex, tenant_email) is None):
                logger.error('Invalid email address')
                return {
                    'statusCode': 400,
                    'body': json.dumps({'error': 'Invalid email address'})
                }
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

    cell_information = retrieve_cell_information(cell_id=cell_id)
    cell_status = check_cell_status(cell_information)
    if cell_status.get('statusCode') == 200:

        # Generate tenant ID
        generated_tenant_id_prefix = random.SystemRandom().choice(string.ascii_lowercase)
        generated_tenant_id = generated_tenant_id_prefix + "".join(random.SystemRandom().choice(string.ascii_lowercase + string.digits) for _ in range(8))

        # Get next available listener priority for this cell
        cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
        ddb_table = dynamodb.Table(cell_management_table)
        priority_response = ddb_table.update_item(
            Key={
                'PK': cell_id
            },
            UpdateExpression='ADD tenant_priority_counter :inc',
            ExpressionAttributeValues={
                ':inc': 10
            },
            ReturnValues='UPDATED_NEW'
        )
        new_tenant_listener_priority = str(int(priority_response['Attributes']['tenant_priority_counter']))

        image_version_param = os.environ.get('IMAGE_VER_SSM_PARAM_NAME')
        # Get Latest Product Container Tag
        image_version = ssm_client.get_parameter(Name=image_version_param)
        product_image_version = image_version['Parameter']['Value']

        response = create_tenant(cell_id=cell_id, tenant_id=generated_tenant_id, tenant_name=tenant_name,
                                 tenant_tier=tenant_tier, tenant_email=tenant_email, tenant_listener_priority=new_tenant_listener_priority,
                                 product_image_version=product_image_version, cell_size=cell_information.get('cell_size'))
        # Log the response
        logger.info('Response: %s', response)
        return response
    else:
        # Log the response
        logger.info('Response: %s', cell_status)
        return cell_status


def retrieve_cell_information(cell_id):
    cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
    ddb_table = dynamodb.Table(cell_management_table)
    try:
        response = ddb_table.get_item(
            Key={
                'PK': cell_id
            }
        )
    except Exception as e:
        logger.error(f"Error retrieving tenant information: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps('Error retrieving tenant information')
        }

    if 'Item' in response:
        item = response['Item']
        return item
    else:
        return {
            'statusCode': 404,
            'body': json.dumps(f'Cell not found: {cell_id}')
        }


def check_cell_status(cell_information):

    cell_status = cell_information.get('current_status')
    cell_utilization = cell_information.get('cell_utilization')
    cell_size = cell_information.get('cell_max_capacity')

    if cell_status == 'available' and int(cell_utilization) < int(cell_size):
        return {
            'statusCode': 200,
            'body': json.dumps(f'Cell has availability of {int(cell_size) - int(cell_utilization)}')
        }
    else:
        return {
            'statusCode': 503,
            'body': json.dumps(f'Cell is currently unavailable or at full capacity')
        }
        

def create_tenant(cell_id, tenant_name, tenant_id, tenant_tier, tenant_email, tenant_listener_priority, product_image_version, cell_size):
    
    # Send a message to EventBridge
    cell_management_bus = os.environ.get('CELL_MANAGEMENT_BUS')
    eventbridge_response = eventbridge_client.put_events(
        Entries=[
            {
                'Source': 'cellManagement.createTenant',
                'DetailType': 'TenantData',
                'Detail': json.dumps({
                    'event_type': 'create_tenant',
                    'cell_id': cell_id,
                    'cell_size': cell_size,
                    'tenant_name': tenant_name,
                    'tenant_id': tenant_id,
                    'tenant_tier': tenant_tier,
                    'tenant_email': tenant_email,
                    'tenant_listener_priority': tenant_listener_priority,
                    'product_image_version': product_image_version
                }),
                'EventBusName': cell_management_bus
            }
        ]
    )

    # Check if the event was sent successfully
    if eventbridge_response['FailedEntryCount'] == 0:
        # Store the metadata in DynamoDB
        cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
        ddb_table = dynamodb.Table(cell_management_table)
        ddb_table.put_item(
            Item={
                'PK': cell_id+"#"+tenant_id,
                'cell_id': cell_id,
                'cell_size': cell_size,
                'tenant_id': tenant_id,
                'tenant_name': tenant_name,
                'tenant_tier': tenant_tier,
                'tenant_email': tenant_email,
                'tenant_listener_priority': tenant_listener_priority,
                'product_image_version': product_image_version,
                'current_status': 'creating',
            }
        )

        logger.info(f'Added tenant metadata to DynamoDB')

        ddb_table.update_item(
            Key={
                'PK': cell_id
            },
            UpdateExpression='SET cell_utilization = cell_utilization + :inc',
            ExpressionAttributeValues={
                ':inc': 1
            },
            ReturnValues='UPDATED_NEW'
        )
        logger.info(f'Cell utilization updated on DynamoDB')
        return {
            'statusCode': 200,
            'body': json.dumps({'CellId': cell_id,'TenantId': tenant_id, 'Status': 'creating'})
        }
    else:
        logger.error(f"Failed to send event to EventBridge")
        return {
            'statusCode': 500,
            'body': json.dumps('Failed to send event to EventBridge')
        }