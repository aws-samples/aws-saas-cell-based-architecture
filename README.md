## Building resilient and scalable SaaS applications with a cell-based architecture
This workshop delves into the realm of cell-based architecture, an approach that has gained traction in recent years for its ability to enhance the scalability, reliability, and efficiency of SaaS architectures. 

This GitHub repository contains the supporting code for this workshop. The workshop link, that contains the detailed instructions to run this workshop, will be added soon. Meanwhile, please use the below instructions to deploy and test.


1. To deploy the solution, use the included deployment script to package and deploy:

`sh ./scripts/deploy.sh`

2. Run the below script to create a new cell. Here 'freetier' is the name of cell, 'S' is cellSize (allowed values are S,M,L) and '1' is the WaveNumber for the cell deployment.

`sh ./scripts/test_createcell.sh freetier S 1`

3. Run the below script to create a new tenant within the cell. Here 'o2345v9' is the cell id (from previous step), 'tenant1' is tenant name and 'test@test.com' is the email for the tenant admin, that is provisioned in Cognito as part of this and 'free' denotes tenant tiers.

`sh ./scripts/test_createtenant.sh o2345v9 tenant1 test@test.com free`

4. Run the below script to activate the tenant. Here 'o2345v9' is the cell id (from create cell step), 'mhmuy9t2p' is tenant id (from create tenant step).

`sh ./scripts/test_activatetenant.sh o2345v9 mhmuy9t2p`

5. Run the below script to add and get products for the tenant. Pass the cell id and tenant id. The below will script will use the cell router to route to the correct cell endpoint.

`sh ./scripts/test_product.sh o2345v9 mhmuy9t2p`

6. If you make any changes to the docker image then run below command to re-upload the app plane source. This will trigger the deployment pipeline.

`sh ./scripts/package-app-plane.sh`


## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

