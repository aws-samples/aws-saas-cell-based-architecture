IMAGE_VERSION=$CODEBUILD_BUILD_NUMBER
echo "image version: $IMAGE_VERSION"

AWS_REGION=$1
ACCOUNT_ID=$2

# Building the code and preparing Product Docker Image
cd ../src

docker build --platform linux/amd64 -f resources/dockerfile -t product-service:$IMAGE_VERSION .
echo "build completed"

# Login to ECR 
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
echo "logged in"

# Tag the image and push it to product-service ECR repo
docker tag product-service:$IMAGE_VERSION $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/product-service:$IMAGE_VERSION
echo "tagged"

docker push $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/product-service:$IMAGE_VERSION
echo "pushed"

# Update the current image version
aws ssm put-parameter --name "/saas/image-version" --type "String" --value $IMAGE_VERSION --overwrite