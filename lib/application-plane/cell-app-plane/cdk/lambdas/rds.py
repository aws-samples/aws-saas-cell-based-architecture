import boto3
import os
import psycopg
from psycopg import sql

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
            # MAINTAINER REVIEW (Req 9.3): `tenant_id` is used as a database
            # identifier. PostgreSQL does not allow bind parameters for
            # identifiers, so it is composed via psycopg.sql.Identifier, which
            # produces a correctly quoted/escaped identifier.
            query(connection, sql.SQL("CREATE DATABASE {0};").format(sql.Identifier(tenant_id)))
            connection.close()

            connection = psycopg.connect(dbname=tenant_id,
                             host=host,
                             port=port,
                             user=username,
                             password=password,
                             autocommit=True)
       

            with open(os.path.join(os.path.dirname(__file__), 'tenant-provisioning.sql'), 'r') as f:
                sql_script = f.read()

            run_provisioning_script(connection, sql_script, tenant_id, tenant_password)
            connection.close()
        elif tenant_state == 'DE-PROVISION':
            # MAINTAINER REVIEW (Req 9.3): `tenant_id` is used as a database
            # identifier and a role identifier. These are non-parameterizable
            # positions, composed via psycopg.sql.Identifier for safe quoting.
            query(connection, sql.SQL("DROP DATABASE {0};").format(sql.Identifier(tenant_id)))
            query(connection, sql.SQL("DROP USER {0};").format(sql.Identifier(tenant_id)))
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

def run_provisioning_script(connection, sql_script, tenant_id, tenant_password):
    """Execute the tenant provisioning script with hardened SQL construction.

    The script contains two kinds of substitutions:

    * `<tenant_id>` — used only in identifier positions (role names and the
      database name in GRANT statements). Identifiers cannot be bound as
      driver parameters in PostgreSQL, so each occurrence is composed via
      psycopg.sql.Identifier for safe, correctly-quoted composition.
      MAINTAINER REVIEW (Req 9.3): these identifier statements are flagged
      for review.
    * `<tenant_pwd>` — a value position (the role password). It is passed as a
      driver-bound parameter rather than interpolated into the SQL text
      (Req 9.1).

    Statements are executed individually and in their original order so the
    password can be passed as a bound parameter (the extended query protocol
    used for parameterized queries permits a single command per execute).
    The effective SQL executed is equivalent to the original script.
    """
    tenant_ident = sql.Identifier(tenant_id)

    statements = [stmt.strip() for stmt in sql_script.split(';') if stmt.strip()]
    for stmt in statements:
        has_password = '<tenant_pwd>' in stmt
        has_identifier = '<tenant_id>' in stmt

        if has_password:
            # Value position -> bound parameter (the quoted '<tenant_pwd>'
            # placeholder, including its surrounding quotes, becomes a single
            # bound parameter). Identifier position -> safe identifier.
            composed = sql.SQL(
                stmt.replace('<tenant_id>', '{tenant_ident}')
                    .replace("'<tenant_pwd>'", '{tenant_pwd}')
            ).format(tenant_ident=tenant_ident, tenant_pwd=sql.Placeholder())
            query(connection, composed, (tenant_password,))
        elif has_identifier:
            composed = sql.SQL(
                stmt.replace('<tenant_id>', '{tenant_ident}')
            ).format(tenant_ident=tenant_ident)
            query(connection, composed)
        else:
            query(connection, sql.SQL(stmt))

def query(connection, sql_statement, params=None):
    connection.execute(sql_statement, params)    

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
