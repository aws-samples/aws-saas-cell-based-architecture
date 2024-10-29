# Cellular Architectures for SaaS
## Cell Application Plane

All the scripts are in the scripts folder

1. To deploy the cell (pass cell name and cell size as param)
```
./deploy-cell.sh cell1 M
```
2. Build the image for product service

```
./build-product-image.sh
```

3. To deploy a new tenant in the cell (pass cell id, tenant id, email address as param)

```
./deploy-tenant.sh cell1 tenant1 xxxxxx@amazon.com
```

4. To update a tenant in the cell (pass cell id, tenant id, email address as param)

```
./update-tenant.sh cell1 tenant1 xxxxxx@amazon.com
```
