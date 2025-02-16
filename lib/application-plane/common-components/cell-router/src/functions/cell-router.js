import cf from 'cloudfront';

const kvsHandle = cf.kvs();

//Set below to true to log out to Cloudwatch Logs
const LOGGING_ENABLED = true;

const ACCESS_DENIED_RESPONSE = {
    status: '401',
    statusDescription: 'Unauthorized',
    headers: {
        'Content-Type': [{
            key: 'Content-Type',
            value: 'application/json'
        }]
    },
    body: "Not authorized"
};

const INVALID_REQUEST_RESPONSE = {
    status: '400',
    statusDescription: 'Bad Request',
    headers: {
        'Content-Type': [{
            key: 'Content-Type',
            value: 'application/json'
        }]
    },
    body: "Valid TenantId and Authorization headers are required"
};

const TIMEOUT_CONFIG = {
    readTimeout: 30,
    connectionTimeout: 5
};

const CUSTOM_ORIGIN_CONFIG = {
    port: 443,
    protocol: "https",
    sslProtocols: ["SSLv3","TLSv1","TLSv1.1","TLSv1.2"]
};

const ORIGIN_ACCESS_CONTROL_CONFIG = {
        enabled: false
};

async function handler(event) {

    let request = event.request;
    let headers = request.headers;
    
    if(!headers.authorization || !isValidAuthToken(headers.authorization.value))
    {
        log('No authorization header provided');
        return ACCESS_DENIED_RESPONSE;
    }
    
    const jwtTenantId = getTenantIdFromJwt(headers.authorization.value);

    try {
        const cellEndpoint = await kvsHandle.get(jwtTenantId,{format: "string"});

        if(!cellEndpoint) {
            log(`No cell endpoint found for ${JSON.stringify(jwtTenantId)}`);
            return INVALID_REQUEST_RESPONSE;
        }
        
        const parsedEndpoint = parseTenantEndpoint(cellEndpoint);
        const encodedPath = encodeURIComponent(parsedEndpoint.path);

        log(`{TenantId: ${jwtTenantId}, Method: ${request.method}, CellEndpoint: ${cellEndpoint}, Hostname: ${parsedEndpoint.hostname}, EncodedPath: ${encodedPath}}`)

        const customOriginRequestObject = {
            domainName: parsedEndpoint.hostname,
            originPath: parsedEndpoint.path,
            timeouts: TIMEOUT_CONFIG,
            originAccessControlConfig: ORIGIN_ACCESS_CONTROL_CONFIG,
            customOriginConfig: CUSTOM_ORIGIN_CONFIG,
        };

        //Set the tenantid header so that ALB can route to the correct tenant
        request.headers['tenantid'] = {value: jwtTenantId};

        cf.updateRequestOrigin(customOriginRequestObject);
        log(`Successfully updated origin for tenant ${jwtTenantId} to ${cellEndpoint}`);
        return request;
    } catch (err) {
        log(`Kvs key lookup failed for ${jwtTenantId}: ${err.message || err}`);
        return INVALID_REQUEST_RESPONSE;
    }
}

function isValidAuthToken(authorization) {
    return typeof authorization === 'string' && authorization.length > 0;
}

function getTenantIdFromJwt(jwtToken) {
    // check token is present
    if (!jwtToken) {
        throw new Error('No token supplied');
    }
    // check number of segments
    const segments = jwtToken.split('.');
    if (segments.length !== 3) {
        throw new Error('Not enough or too many segments');
    }

    const payloadSeg = segments[1];
    // base64 decode and parse JSON
    const payload = JSON.parse(Buffer.from(payloadSeg, 'base64url'));
    const jwtTenantId = payload["custom:tenantId"];
    return jwtTenantId;
}

function log(message) {
    if (LOGGING_ENABLED) {
        console.log(message);
    }
}

function parseTenantEndpoint(endpointUrl) {
    const URL_PREFIX = "https://";
    const cleaned_endpoint = endpointUrl.substring(endpointUrl.indexOf(URL_PREFIX) + URL_PREFIX.length);
    const slashIndex = cleaned_endpoint.indexOf("/");
    
    return {
        originalEndpoint: endpointUrl,
        hostname: cleaned_endpoint.substring(0, slashIndex),
        path: cleaned_endpoint.substring(slashIndex, cleaned_endpoint.length - 1)
    };
}