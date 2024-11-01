from flask import Flask, request, jsonify, Response
import boto3
from botocore.exceptions import NoCredentialsError, PartialCredentialsError, ClientError
import os
import psycopg
from models.product_models import Product
import json
import logging
from jose import jwk, jwt
from jose.utils import base64url_decode
import string
import random

#A function that created a 1MB dummy log entry. This log entry will be used to simulate the failure of logging to Amazon CloudWatch. The 1MB will fill up the logging buffer very fast. 
def generate_large_log_entry(size_mb=1):
    """Generate a string of approximately size_mb megabytes"""
    # 1 MB = 1048576 bytes
    # Using ASCII letters for the content
    chars = string.ascii_letters + string.digits
    return ''.join(random.choice(chars) for _ in range(1048576))

secrets_manager = boto3.client('secretsmanager', region_name=os.environ['AWS_REGION'])

app = Flask(__name__)
app.logger.setLevel(logging.DEBUG)

def get_tenant_id(request):
    bearer_token = request.headers.get('Authorization')
    if not bearer_token:
        return None
    token = bearer_token.split(" ")[1]
    # get the tenant id from the token
    tenant_id = jwt.get_unverified_claims(token)['custom:tenantId']
    return tenant_id

def get_tenant_secret(tenant_id):
    response = secrets_manager.get_secret_value(SecretId=tenant_id+'Credentials')
    
    secret_value = response['SecretString']
    #convert string to json
    secret_value = json.loads(secret_value)

    password = secret_value["password"]
    host = secret_value["host"]
    port = secret_value["port"]
    username = secret_value["username"]
    print(password, host, port)
    return password, host, port, username

def tenant_connection(tenant_id):
    password, host, port, username = get_tenant_secret(tenant_id)
                                 
    connection = psycopg.connect(dbname=tenant_id,
                             host=host,
                             port=port,
                             user=username,
                             password=password,
                             autocommit=True)                                 
    return connection

@app.route('/')
def home():
    return "Welcome to ProductService!!"

@app.route('/health', methods=['GET'])
def health_check():
    health_status = {
        'status': 'UP',
        'details': 'Application is running smoothly!!'
    }
    return jsonify(health_status)


@app.route('/product', methods=['POST'])
def create_product():
    connection = None
    try:
        # Generate and log 1MB entry
        large_log = generate_large_log_entry()
        app.logger.info(f"Large log entry: {large_log}")
        
        app.logger.info (request.headers)  
        app.logger.info ("This is a new deployment of the application")
        #tenant_id = request.headers.get('tenantId')
        tenant_id = get_tenant_id(request)
        app.logger.info(tenant_id)
        if not tenant_id:
            return jsonify({"error": "tenantId header is required"}), 400
        
        connection = tenant_connection(tenant_id)    
        product_info = request.get_json()
        product = Product(**product_info, tenantId=tenant_id)        
        connection.execute("INSERT INTO app.products (product_id, product_name, product_description, product_price, tenant_id) VALUES (%s, %s, %s, %s, %s)", (product.productId, product.productName, product.productDescription, product.productPrice, product.tenantId))
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if connection:
            connection.close()
        

    return jsonify({"message": "product created"}), 200


@app.route('/product', methods=['GET'])
def get_products():
    connection = None    
    try:
        app.logger.info (request.headers)            
        #tenant_id = request.headers.get('tenantId')
        tenant_id = get_tenant_id(request)
        app.logger.info (tenant_id)
    
        if not tenant_id:
            return jsonify({"error": "tenantId header is required"}), 400
        
        connection = tenant_connection(tenant_id)                
        cur = connection.execute("SELECT product_id, product_name, product_description, product_price, tenant_id FROM app.products WHERE tenant_id = '{0}'".format(tenant_id))
        results = cur.fetchall()
        app.logger.info(results)
        products=[]
        for record in results:
            product = Product(record[0], record[1], record[2], record[3], record[4])
            products.append(product.__dict__)

        app.logger.info (products)
                
        return jsonify(products), 200

    except Exception as e:
        return jsonify({"error while getting product": str(e)}), 500
    finally:
        if connection:
            connection.close()
    
    return jsonify(product.__dict__), 200 

if __name__ == "__main__":
    app.run("0.0.0.0", port=80, debug=False)