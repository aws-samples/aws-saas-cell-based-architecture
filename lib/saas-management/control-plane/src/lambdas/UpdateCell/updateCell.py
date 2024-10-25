
import base64
import json
import os
import boto3
import logging

# Initialize clients
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
            if "WaveNumber" in data or "CellName" in data:
                logger.info('Request body: %s', data)

                cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
                ddb_table = dynamodb.Table(cell_management_table)

                cell_id = data.get('CellId')
                cell_name = data.get('CellName',None)
                cell_wave_number = data.get('WaveNumber',None)

                exp_attr_values = {}                     
                update_exp = ""

                if cell_name is not None:
                    update_exp += "set cell_name = :cn"
                    exp_attr_values[':cn'] = cell_name
                if cell_wave_number is not None:
                    if update_exp:
                        update_exp += ", wave_number = :wn"
                    else:
                        update_exp = "set wave_number = :wn"
                    exp_attr_values[':wn'] = cell_wave_number

                dynamo_response = ddb_table.update_item(
                    Key={
                        'PK': cell_id
                    },
                    UpdateExpression=update_exp,
                    ExpressionAttributeValues=exp_attr_values,
                    ReturnValues="UPDATED_NEW"
                )

                # Process the request and generate a response
                response = {
                    'statusCode': 200,
                    'body': json.dumps({'CellId': cell_id, 'Status': 'updated'})
                }
            else:
                logger.info('Invalid Request: WaveNumber or CellName not present')
                response = {
                    'statusCode': 400,
                    'body': json.dumps({'error': 'WaveNumber or CellName not present'})
                }
        except json.JSONDecodeError:
            logger.error('Invalid JSON in request body')
            response = {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON in request body'})
            }
    else:
        logger.info('Invalid Request: WaveNumber, CellName or both must be provided')
        response = {
            'statusCode': 400,
            'body': json.dumps({'error': 'WaveNumber, CellName or both must be provided'})
        }
    # Log the response
    logger.info('Response: %s', response)
    return response