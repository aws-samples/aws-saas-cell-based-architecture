import json
import os
import boto3
import logging
import json
import boto3
import string
import random

# Initialize clients
eventbridge_client = boto3.client('events')
dynamodb = boto3.resource('dynamodb')

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

            # Get cellName and cellSize from the request body
            cell_name = data.get('CellName')
            cell_size = data.get('CellSize')
            wave_number = data.get('WaveNumber')
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
    
    # ID's need to start with a letter
    generated_cell_id_prefix = random.SystemRandom().choice(string.ascii_lowercase)
    # Generate a random string containing lowercase letters and numbers only
    generated_cell_id = generated_cell_id_prefix + "".join(random.SystemRandom().choice(string.ascii_lowercase + string.digits) for _ in range(6))

    response = create_cell(cell_id=generated_cell_id, cell_name=cell_name, cell_size=cell_size, wave_number=wave_number)

    # Log the response
    logger.info('Response: %s', response)

    return response


def create_cell(cell_id, cell_name, cell_size, wave_number):
    # Send a message to EventBridge
    cell_management_bus = os.environ.get('CELL_MANAGEMENT_BUS')
    eventbridge_response = eventbridge_client.put_events(
        Entries=[
            {
                'Source': 'cellManagement.createCell',
                'DetailType': 'CellData',
                'Detail': json.dumps({
                    'event_type': 'create_cell',
                    'cell_id': cell_id,
                    'cell_name': cell_name,
                    'cell_size': cell_size,
                    'wave_number': wave_number
                }),
                'EventBusName':  cell_management_bus
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
                'PK': cell_id,
                'cell_name': cell_name,
                'cell_size': cell_size,
                'wave_number': wave_number,
                'current_status': 'creating',
                'cell_utilization': 0
            }
        )
        return {
            'statusCode': 200,
            'body': json.dumps({'CellId': cell_id, 'Status': 'creating'})
        }
    else:
        logger.error(f"Failed to send event to EventBridge")
        return {
            'statusCode': 500,
            'body': json.dumps('Failed to send event to EventBridge')
        }
