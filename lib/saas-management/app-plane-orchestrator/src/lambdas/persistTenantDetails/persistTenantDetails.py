import json
import boto3
import logging
import os

eventbridge_client = boto3.client('events')

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
     
    logger.info('Received event: %s', event)

    # Send a message to EventBridge
    cell_management_bus = os.environ.get('CELL_MANAGEMENT_BUS')

    build_outputs = event.get("StackOutputs")

    eventBridge_message = {
        'Source': 'cellManagement.tenantCreated',
        'DetailType': 'TenantDetails',
        'EventBusName':  cell_management_bus
    }

    detail = {}

    for item in build_outputs:
        name = item['Name']
        value = item['Value']
        json_to_append = {name:value}
        detail.update(json_to_append)

    eventBridge_message.update({'Detail': json.dumps(detail)})

    logger.info('EventBridge Message Generated: %s', eventBridge_message)

    eventbridge_response = eventbridge_client.put_events(
        Entries=[
            eventBridge_message
        ]
    )

    # Check if the event was sent successfully
    if eventbridge_response['FailedEntryCount'] == 0:
        return {
            'statusCode': 200,
        }
    else:
        logger.error(f"Failed to send event to EventBridge")
        logger.error(eventbridge_response)
        return {
            'statusCode': 500,
            'body': json.dumps('Failed to send event to EventBridge')
        }