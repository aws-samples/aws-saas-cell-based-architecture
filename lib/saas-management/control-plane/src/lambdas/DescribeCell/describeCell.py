
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
            logger.info('CellId: %s', cellId)
        except json.JSONDecodeError:
            logger.error('Invalid JSON in request body')
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Invalid JSON in request body'})
            }
        else:
            return describe_cell(cellId)
    else:
        logger.info('No CellId found!')

    # Process the request and generate a response
    response = {
        'statusCode': 200,
        'body': json.dumps({'message': 'This is a response from the DescribeCell Lambda!'})
    }

    # Log the response
    logger.info('Response: %s', response)

    return response

def describe_cell(cell_id):

        cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
        ddb_table = dynamodb.Table(cell_management_table)
        try:
            ddb_response = ddb_table.get_item(
                Key={
                    'PK': cell_id
                }
            )
        except Exception as e:
            logger.error(f"Error retrieving cell status: {str(e)}")
            return {
                'statusCode': 500,
                'body': json.dumps('Error retrieving tenant status')
            }

        if 'Item' in ddb_response:
            item = ddb_response['Item']
            cell_name = item.get('cell_name')
            cell_status = item.get('current_status')
            cell_utilization = item.get('cell_utilization','0')
            cell_size = item.get('cell_size','not available')
            wave_number = item.get('wave_number')
                                                                    
            if cell_status == 'creating':
                return {
                    'statusCode': 200,
                    'body': json.dumps({
                        'CellId': cell_id,
                        'CellName': cell_name,
                        'Status': cell_status,
                        'CellSize': cell_size,
                        'CellCurrentUtilization': int(cell_utilization),
                        'DeploymentWave': int(wave_number)
                    })
                }
            else:
                cell_url = item.get('cell_url','not available')
                cell_max_capacity = item.get('cell_max_capacity','0')
                return {
                    'statusCode': 200,
                    'body': json.dumps({
                        'CellId': cell_id,
                        'CellName': cell_name,
                        'Status': cell_status,
                        'CellUrl': cell_url,
                        'CellSize': cell_size,
                        'CellCurrentUtilization': int(cell_utilization),
                        'CellMaxSize': int(cell_max_capacity),
                        'DeploymentWave': int(wave_number)
                    })
                }

        else:
            return {
                'statusCode': 404,
                'body': json.dumps(f'Cell not found: {cell_id}')
            }