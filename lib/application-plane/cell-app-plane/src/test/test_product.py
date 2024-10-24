# import unittest
# from unittest.mock import patch, MagicMock
# from flask import Flask, request, jsonify, Response
# from product_media import app, get_bucketName_from_parameterstore, upload_to_s3
# from botocore.exceptions import ClientError  # Import added

# class ProductMediaTestCase(unittest.TestCase):

#     def setUp(self):
#         self.app = app.test_client()
#         self.app.testing = True

#     @patch('product_media.get_bucketName_from_parameterstore')
#     def test_health_check(self, mock_get_bucketName):
#         response = self.app.get('/health')
#         self.assertEqual(response.status_code, 200)
#         self.assertEqual(response.json, {'status': 'UP', 'details': 'Application is running smoothly!!'})

#     @patch('product_media.get_bucketName_from_parameterstore')
#     @patch('product_media.boto3.client')
#     def test_upload_file_success(self, mock_boto_client, mock_get_bucketName):
#         mock_get_bucketName.return_value = 'mock-bucket'
#         mock_s3 = MagicMock()
#         mock_boto_client.return_value = mock_s3

#         data = {
#             'file': (open('test.txt', 'rb'), 'test.txt')
#         }
#         headers = {
#             'tenantId': 'tenant123',
#             'productId': 'product123'
#         }
#         response = self.app.post('/productmedia', data=data, headers=headers, content_type='multipart/form-data')
#         self.assertEqual(response.status_code, 200)
#         self.assertIn('successfully uploaded to S3 Bucket', response.json['message'])

#     @patch('product_media.get_bucketName_from_parameterstore')
#     @patch('product_media.boto3.client')
#     def test_upload_file_no_file(self, mock_boto_client, mock_get_bucketName):
#         response = self.app.post('/productmedia', content_type='multipart/form-data')
#         self.assertEqual(response.status_code, 400)
#         self.assertEqual(response.json, {"error": "No file part"})

#     @patch('product_media.get_bucketName_from_parameterstore')
#     @patch('product_media.boto3.client')
#     def test_upload_file_no_tenantId(self, mock_boto_client, mock_get_bucketName):
#         mock_get_bucketName.return_value = 'mock-bucket'
#         mock_s3 = MagicMock()
#         mock_boto_client.return_value = mock_s3

#         data = {
#             'file': (open('test.txt', 'rb'), 'test.txt')
#         }
#         headers = {
#             'productId': 'product123'
#         }
#         response = self.app.post('/productmedia', data=data, headers=headers, content_type='multipart/form-data')
#         self.assertEqual(response.status_code, 400)
#         self.assertEqual(response.json, {"error": "tenantId header is required"})

#     @patch('product_media.get_bucketName_from_parameterstore')
#     @patch('product_media.boto3.client')
#     def test_get_file_success(self, mock_boto_client, mock_get_bucketName):
#         mock_get_bucketName.return_value = 'mock-bucket'
#         mock_s3 = MagicMock()
#         mock_s3.get_object.return_value = {'Body': MagicMock(read=MagicMock(return_value=b'test content'))}
#         mock_boto_client.return_value = mock_s3

#         headers = {
#             'tenantId': 'tenant123'
#         }
#         response = self.app.get('/productmedia/product123/test.txt', headers=headers)
#         self.assertEqual(response.status_code, 200)
#         self.assertEqual(response.data, b'test content')
#         self.assertEqual(response.headers['Content-Disposition'], 'attachment; filename=test.txt')

#     @patch('product_media.get_bucketName_from_parameterstore')
#     @patch('product_media.boto3.client')
#     def test_get_file_not_found(self, mock_boto_client, mock_get_bucketName):
#         mock_get_bucketName.return_value = 'mock-bucket'
#         mock_s3 = MagicMock()
#         mock_s3.get_object.side_effect = ClientError(
#             {"Error": {"Code": "404", "Message": "Not Found"}}, 'get_object')
#         mock_boto_client.return_value = mock_s3

#         headers = {
#             'tenantId': 'tenant123'
#         }
#         response = self.app.get('/productmedia/product123/test.txt', headers=headers)
#         self.assertEqual(response.status_code, 404)
#         self.assertEqual(response.json, {"error": "The requested file does not exist in S3"})

# if __name__ == '__main__':
#     unittest.main()
