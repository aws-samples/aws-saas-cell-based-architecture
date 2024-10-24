
import base64
import json
import os
import boto3
import logging

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
        'body': json.dumps({'message': 'This is a response from the UpdateCell Lambda!'})
    }

    # Log the response
    logger.info('Response: %s', response)

    return response