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

class ConfigError(ValueError):
    '''Raise when an unexpected router config error is encountered'''

class ConfigAccessError(ValueError):
    '''Raise when router config can't be accessed'''

class ConfigFormatError(ValueError):
    '''Raise when router config is invalid or malformed'''

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
            configMap = get_config_map()
            if tenantId in configMap:
                cell_url = configMap[tenantId]
                cell_url_components = urlparse(cell_url)
        except (Exception,ConfigError) as e:
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

def get_config_map():
    """
    Retrieves and caches a configuration object from an Amazon S3 bucket.

    This function implements a caching mechanism for the configuration object. It checks if the 
    configuration is already cached and not expired. If the cache is invalid or expired, it fetches 
    a new configuration from S3.

    The function uses the following logic:
    1. If there's no cached data or it has expired, attempt to fetch from S3.
    2. If fetching fails and there's no cached data, raise an error.
    3. If fetching fails but there's expired cached data, return the expired data.
    4. If the cache is valid and not expired, return the cached data.

    Returns:
        dict: The configuration object as a Python dictionary, either freshly fetched or from cache.

    Raises:
        ConfigError: If there's no cached data and fetching from S3 fails.

    Global Variables:
        mapping_data (dict): Stores the parsed configuration object.
        last_updated_timestamp (int): Stores the timestamp (in milliseconds) of the last update.
        CACHE_THRESHOLD (int): The cache expiration time in milliseconds.

    Note:
        This function relies on the `get_versioned_json_from_s3()` function to fetch data from S3.
        It handles ConfigAccessError, ConfigFormatError, and ConfigError exceptions from that function.

    Example:
        try:
            config = get_config_map()
            # Use the config...
        except ConfigError as e:
            print(f"Failed to get configuration: {e}")
    """
    global mapping_data, last_updated_timestamp
    current_time = round(time.time() * 1000)
    
    # if the variables have not been initialised, or they haven't been fetched in a while...
    if mapping_data is None or last_updated_timestamp is None or ((current_time - last_updated_timestamp) > CACHE_THRESHOLD):

        # This is the high risk scenario... we have no previously known good version in memory to fall back on...
        if mapping_data is None or last_updated_timestamp is None:
            print('No cached config object, so fetching from S3')
            try:
                mapping_data = get_versioned_json_from_s3()
                last_updated_timestamp = current_time
                print('Successfully fetched and cached config object')
                return mapping_data
            except ConfigAccessError as cae:
                print(f'Error retrieving config object: {cae}')
                raise ConfigError('A problem occured loading Routing configuration')
            except ConfigFormatError as cfe:
                print(f'Error parsing config object: {cfe}')
                raise ConfigError('A problem occured parsing Routing configuration')
            except ConfigError as ce:
                print(f'Unexpected Error retrieving or parsing config object: {ce}')
                raise ConfigError('A problem occured retrieving and validating the Routing configuration')
        elif (current_time - last_updated_timestamp) > CACHE_THRESHOLD:
            print('Cached config object has expired, so fetching from S3')
            try:
                mapping_data = get_versioned_json_from_s3()
                last_updated_timestamp = current_time
                print('Successfully fetched and cached config object')
                return mapping_data
            except ConfigAccessError as cae:
                print(f'Error retrieving config object: {cae}')
                print(f"returning the previous known good version of the router configuration")
                return mapping_data
            except ConfigFormatError as cfe:
                print(f'Error parsing config object: {cfe}')
                print(f"returning the previous known good version of the router configuration")
                return mapping_data
            except ConfigError as ce:
                print(f'Unexpected Error retrieving or parsing config object: {ce}')
                print(f"returning the previous known good version of the router configuration")
                return mapping_data
    else:
        print('Using cached config object')
        return mapping_data

def get_versioned_json_from_s3():
    """
    Retrieves and parses a JSON configuration object from an S3 bucket.

    This function attempts to fetch a JSON object from a specified S3 bucket and key,
    decode its contents, and parse it as JSON. It includes error handling for various
    potential issues that may occur during this process.

    Returns:
        dict: The parsed JSON data as a Python dictionary.

    Raises:
        ConfigAccessError: If there's an issue accessing the S3 bucket or object.
        ConfigFormatError: If the retrieved object cannot be parsed as valid JSON.
        ConfigError: For any other unexpected errors during retrieval or parsing.

    Note:
        This function assumes that the following global variables are defined:
        - s3: A boto3 S3 client
        - BUCKET_NAME: The name of the S3 bucket containing the config object
        - OBJECT_KEY: The key (path) of the config object within the bucket

    Example:
        try:
            config = get_versioned_json_from_s3()
            # Use the config...
        except (ConfigAccessError, ConfigFormatError, ConfigError) as e:
            print(f"Configuration error: {e}")
    """
    try:
        print('Fetching config object from S3')
        # Get the object from S3
        response = s3.get_object(Bucket=BUCKET_NAME, Key=OBJECT_KEY)

        # Read and decode the object content
        object_content = response['Body'].read().decode('utf-8')
        
        # Parse the JSON
        mapping_data = json.loads(object_content)
        return mapping_data
    except ClientError as ce:
        print(f'Error retrieving config object: {ce}')
        raise ConfigAccessError('A problem occured accessing Routing config')
    except json.JSONDecodeError as jde:
        print(f'Error parsing config object: {jde}')
        raise ConfigFormatError('The Routing config is invalid')
    except Exception as e:
        print(f'Unexpected Error retrieving or parsing config object: {e}')
        raise ConfigError('An unexpected problem occurred retrieving and parsing the Routing config')