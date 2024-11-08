import base64
import json
import os
import boto3
import logging
from aws_embedded_metrics import metric_scope
from aws_embedded_metrics.storage_resolution import StorageResolution
from aws_embedded_metrics.config import get_config
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

Config = get_config()
Config.service_type = "CellObserver"

DYNAMO_CELL_MANAGEMENT_TABLE = os.environ.get('CELL_MANAGEMENT_TABLE')

dynamodb = boto3.resource('dynamodb')
ddb_table = dynamodb.Table(DYNAMO_CELL_MANAGEMENT_TABLE)

def handler(event, context):
     
    # Log the entire event
    logger.debug('Received event: %s', event)

    response = list_and_process_cells()

    # Log the response
    logger.info('Response: %s', response)
    return response

def list_and_process_cells():
    cell_management_table = os.environ.get('CELL_MANAGEMENT_TABLE')
    table = dynamodb.Table(cell_management_table)
    cells = []
    scan_kwargs = {
        "ProjectionExpression": "PK, cell_name, cell_max_capacity, cell_utilization, current_status"
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
                # We're only interested in cells, so ignore the tenants (PK's with a #)
                if "#" in item['PK']:
                    dynamo_response.remove(item)
                # If the cell is provisioning or failed to provision, ignore
                elif "available" not in item['current_status']:
                    dynamo_response.remove(item)
                else:
                    item['CellId'] = item.pop('PK')
                    item['CellName'] = item.pop('cell_name')
                    item['Status'] = item.pop('current_status')
                    item['CellMaxSize'] = item.pop('cell_max_capacity')
                    item['CellUtilization'] = item.pop('cell_utilization')
            cells.extend(response.get("Items", []))
            start_key = response.get("LastEvaluatedKey", None)
            done = start_key is None
    except Exception as e:
        logger.error("Couldn't scan for cells: %s",e)
        raise
    else:
        for cell in cells:
            logger.info("Cell: %s", cell)
            try:
                emit_cell_metrics(cell)
            except Exception as e:
                logger.error("Error processing metrics for cell: %s", e)

    # Process the request and generate a response
    response = {
        'statusCode': 200,
        'body': {
            "processed": True
            }
    }
    return response

@metric_scope
def emit_cell_metrics(cell_details,metrics):
    try:
        cell_id = cell_details['CellId']
        cell_name = cell_details['CellName']
        cell_max_size = cell_details['CellMaxSize']
        cell_utilization = cell_details['CellUtilization']

        # Emit metrics
        logger.info("Emitting metrics for cell: %s", cell_id)
        logger.info("Cell name: %s", cell_name)
        logger.info("Cell max size: %s", cell_max_size)
        logger.info("Cell utilization: %s", cell_utilization)

        # Emit metrics
        metrics.reset_dimensions(False)
        metrics.set_namespace("CellManagement")
        metrics.put_dimensions({ "CellId": cell_id,"CellName": cell_name })
        metrics.put_metric("CellUtilization", int(cell_utilization), "Count", StorageResolution.STANDARD)
        metrics.put_metric("CellMaxSize", int(cell_max_size), "Count", StorageResolution.STANDARD)

    except Exception as e:
        logger.error("Error emitting metrics: %s", e)