import json
import boto3
import time
from botocore.exceptions import ClientError
from botocore.config import Config
from urllib.parse import urlparse


# The following constants are populated by CDK at deployment time
BUCKET_NAME = 'S3_BUCKET_NAME'
OBJECT_KEY = 'S3_OBJECT_KEY'

# Constant defining how long to cache the config map from S3
CACHE_THRESHOLD = 120000

mapping_data = None
last_updated_timestamp = None

# Create an S3 client with keepalives to maximise performance
s3 = boto3.session.Session().client(
    's3', 
    region_name='us-east-1',
    config=Config(tcp_keepalive=True,retries={'mode': 'adaptive'})
)

def lambda_handler(event, context):
    """
    AWS Lambda function handler for routing incoming requests based on tenant ID.

    This function is designed to be used as an AWS Lambda function handler. It receives an event
    object containing the incoming request data from Amazon CloudFront. The function checks if the
    request headers contain a 'tenantid' key. If present, it retrieves the corresponding cell URL
    from a configuration map and modifies the request to route it to the appropriate cell URL.

    Args:
        event (dict): The event object containing the incoming request data from Amazon CloudFront.
        context (object): The Lambda context object, which is not used in this function.

    Returns:
        dict: The modified request object with the updated origin and host header if a tenant ID is found,
              or the original request object if no tenant ID is present.

    Raises:
        Exception: If an unexpected error occurs while retrieving or parsing the configuration object.
    """
    request = event['Records'][0]['cf']['request']
    print("event: ",event)
    
    # If the tenantId header is present in the request
    if "tenantid" in request['headers'] and "authorization" in request['headers']:
        tenantId = request['headers'].get('tenantid')[0].get('value')
        authorization = request['headers'].get('authorization')[0].get('value')
        print('Tenant ID:', tenantId)
        try:
            configMap = getConfigMap()
            if tenantId in configMap:
                cell_url = configMap[tenantId]
                cell_url_components = urlparse(cell_url)
        except Exception as e:
            print(f'Unexpected Error retrieving or parsing config object: {e}')
        else:
            request['origin'] = {
                'custom': {
                    'domainName': cell_url_components.netloc,
                    'port': 443,
                    'protocol': 'https',
                    'path': cell_url_components.path[:-1],
                    'readTimeout': 5,
                    'keepaliveTimeout': 5,
                    'customHeaders': {},
                    'originProtocolPolicy': 'https-only',
                    "sslProtocols": [
                        "TLSv1",
                        "TLSv1.1",
                        "TLSv1.2"
                    ]
                }
            }
            request['headers']['host'] = [{'key': 'host', 'value': cell_url_components.netloc}]
            request['headers']['authorization'] = [{'key': 'Authorization', 'value': authorization}]
            print("new request: ",json.dumps(request))
            return request
    elif "authorization" not in request['headers']:
        print('Authorization not found in request headers, so returning a 401 response code')
        response = {
            'status': '401',
            'statusDescription': 'Unauthorized',
            'headers': {
                'Content-Type': [
                    {
                    'key': 'Content-Type',
                    'value': 'application/json'
                    }
                ]
            },
            'body': "Not authorized"
        }
        return response
    else:
        print('TenantId not found in request headers, so returning a 400 response code')
        response = {
            'status': '400',
            'statusDescription': 'Bad Request',
            'headers': {
                'Content-Type': [
                    {
                    'key': 'Content-Type',
                    'value': 'application/json'
                    }
                ]
            },
            'body': "TenantId and Authorization headers are required"
        }
        return response

def getConfigMap():
    """
    Retrieves a configuration object from an Amazon S3 bucket and caches it in memory.

    This function checks if the configuration object is already cached in memory and if the cached
    object has not expired based on a predefined cache threshold (CACHE_THRESHOLD). If the cached
    object is not available or has expired, it fetches the configuration object from an Amazon S3
    bucket specified by the BUCKET_NAME and OBJECT_KEY constants.

    The configuration object is expected to be a JSON file. The function reads the object content
    from S3, parses the JSON data, and stores it in the global mapping_data variable. It also updates
    the last_updated_timestamp global variable with the current time in milliseconds.

    If an error occurs during the retrieval or parsing of the configuration object, the function
    prints an error message with the exception details.

    Returns:
        dict: The parsed configuration object as a Python dictionary.

    Raises:
        ClientError: If an error occurs while retrieving the object from Amazon S3.
        json.JSONDecodeError: If an error occurs while parsing the JSON data.
        Exception: If an unexpected error occurs during the retrieval or parsing process.

    Global Variables:
        mapping_data (dict): Stores the parsed configuration object.
        last_updated_timestamp (int): Stores the timestamp (in milliseconds) when the configuration
            object was last updated.
    """

    global mapping_data, last_updated_timestamp
    current_time = round(time.time() * 1000)
    
    # if the variables have not been initialised, or they haven't been fetched in a while...
    if mapping_data is None or last_updated_timestamp is None or ((current_time - last_updated_timestamp) > CACHE_THRESHOLD):

        if mapping_data is None or last_updated_timestamp is None:
            print('No cached config object, fetching from S3')
        elif (current_time - last_updated_timestamp) > CACHE_THRESHOLD:
            print('Cached config object has expired, fetching from S3')

        # We replace the global variables only if everything works in this block...
        try:
            print('Fetching config object from S3')
            # Get the object from S3
            response = s3.get_object(Bucket=BUCKET_NAME, Key=OBJECT_KEY)

            # Read and decode the object content
            object_content = response['Body'].read().decode('utf-8')
            
            # Parse the JSON and store it in the global variable
            mapping_data = json.loads(object_content)

            # Set the last updated timestamp to the current time in millis
            last_updated_timestamp = current_time

        except ClientError as e:
            print(f'Error retrieving config object: {e}')
        except json.JSONDecodeError as e:
            print(f'Error parsing config object: {e}')
        except Exception as e:
            print(f'Unexpected Error retrieving or parsing config object: {e}')
    else:
        print('Using cached config object')
    return mapping_data