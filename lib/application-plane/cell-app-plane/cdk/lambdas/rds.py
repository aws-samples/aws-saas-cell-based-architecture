import boto3
import os
import psycopg

secrets_manager = boto3.client('secretsmanager')

def handler(event, context):
    try:
        creds_secret_name = os.getenv('DB_CRED_SECRET_NAME')                
        tenant_state = event.get('tenantState')
        tenant_id = event.get('tenantId') 
        tenant_secret_name = event.get('tenantSecretName')
        print(tenant_secret_name)
        
        password, username, host, port = get_secret_value(creds_secret_name)

        tenant_password, tenant_username, tenant_host, tenant_port = get_secret_value(tenant_secret_name)
        print(tenant_password, tenant_username, tenant_host, tenant_port)
        
        connection = psycopg.connect(dbname='postgres',
                             host=host,
                             port=port,
                             user=username,
                             password=password,
                             autocommit=True)
        
        if tenant_state == 'PROVISION':
            query(connection, "CREATE DATABASE {0};".format(tenant_id))
            connection.close()

            connection = psycopg.connect(dbname=tenant_id,
                             host=host,
                             port=port,
                             user=username,
                             password=password,
                             autocommit=True)
       

            with open(os.path.join(os.path.dirname(__file__), 'tenant-provisioning.sql'), 'r') as f:
                sql_script = f.read()

            sql_script = sql_script.replace("<tenant_id>",tenant_id).replace("<tenant_pwd>", tenant_password)
            print(sql_script)

            query(connection, sql_script)
            connection.close()
        elif tenant_state == 'DE-PROVISION':
            query(connection, "DROP DATABASE {0};".format(tenant_id))
            query(connection, "DROP user {0};".format(tenant_id))
            connection.close()
        else:
            return {
                'status': 'ERROR',
                'err': 'INVALID TENANT STATE',
                'message': 'INVALID TENANT STATE'
            }    
        return {
            'status': 'OK',
            'results': "tenant created"
        }
    except Exception as err:
        return {
            'status': 'ERROR',
            'err': str(err),
            'message': str(err)
        }

def query(connection, sql):
    connection.execute(sql)    

def get_secret_value(secret_id):
    response = secrets_manager.get_secret_value(SecretId=secret_id)
    secret_value = response['SecretString']

    #convert string to json
    secret_value = eval(secret_value)
    
    password = secret_value["password"]
    username = secret_value["username"]
    host = secret_value["host"]
    port = secret_value["port"]
    
    return password, username, host, port

