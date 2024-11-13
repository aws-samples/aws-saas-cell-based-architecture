
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
        return list_cells()
    except Exception as e:
        logger.error("Couldn't scan for cells: %s",e)
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'A Problem occured listing cells'})
        }

def list_cells():
    cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
    table = dynamodb.Table(cell_management_table)
    cells = []
    scan_kwargs = {
        "ProjectionExpression": "PK, cell_name, current_status, cell_utilization"
    }
    try:
        done = False
        start_key = None
        while not done:
            if start_key:
                scan_kwargs["ExclusiveStartKey"] = start_key
            response = table.scan(**scan_kwargs)
            dynamo_response = response.get("Items",[])
            # Iterate over a copy of the list to avoid semgrep list-modify-while-iterate rule.
            for item in dynamo_response[:]:
                if "#" in item['PK']:
                    dynamo_response.remove(item)
                else:
                    item['CellId'] = item.pop('PK')
                    item['CellName'] = item.pop('cell_name')
                    item['Status'] = item.pop('current_status')
                    item['CellUtilization'] = str(item.pop('cell_utilization'))
            cells.extend(response.get("Items", []))
            start_key = response.get("LastEvaluatedKey", None)
            done = start_key is None
    except Exception as e:
        logger.error("Couldn't scan for cells: %s",e)
        raise

    # Process the request and generate a response
    response = {
        'statusCode': 200,
        'body': json.dumps(cells)
    }
    return response