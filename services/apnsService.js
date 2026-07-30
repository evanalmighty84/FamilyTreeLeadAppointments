const http2 = require('http2');
const jwt = require('jsonwebtoken');

let cachedProviderToken = null;
let cachedProviderTokenCreatedAt = 0;

function requiredEnvironmentValue(name) {
    const value = String(
        process.env[name] || ''
    ).trim();

    if (!value) {
        throw new Error(`${name} is not configured`);
    }

    return value;
}

function getPrivateKey() {
    return requiredEnvironmentValue(
        'APNS_PRIVATE_KEY'
    ).replace(/\\n/g, '\n');
}

function getProviderToken() {
    const nowSeconds =
        Math.floor(Date.now() / 1000);

    /*
     * APNs provider tokens are valid for one hour.
     * Refresh at 50 minutes.
     */
    if (
        cachedProviderToken &&
        nowSeconds -
        cachedProviderTokenCreatedAt <
        50 * 60
    ) {
        return cachedProviderToken;
    }

    const teamId =
        requiredEnvironmentValue(
            'APPLE_TEAM_ID'
        );

    const keyId =
        requiredEnvironmentValue(
            'APNS_KEY_ID'
        );

    cachedProviderToken = jwt.sign(
        {
            iss: teamId
        },
        getPrivateKey(),
        {
            algorithm: 'ES256',
            header: {
                alg: 'ES256',
                kid: keyId
            }
        }
    );

    cachedProviderTokenCreatedAt =
        nowSeconds;

    return cachedProviderToken;
}

function apnsHost(environment) {
    return environment === 'development'
        ? 'api.sandbox.push.apple.com'
        : 'api.push.apple.com';
}

function sendVendorPush({
                            deviceToken,
                            environment = 'production',
                            title,
                            body,
                            requestId = null,
                            vendorId,
                            badge = 1,
                            notificationType =
                            'vendor_service_request',
                            customData = {}
                        }) {
    return new Promise((resolve) => {
        let client;
        let request;
        let responseBody = '';
        let statusCode = 0;
        let settled = false;

        const finish = (result) => {
            if (settled) {
                return;
            }

            settled = true;

            try {
                request?.close();
            } catch (_) {}

            try {
                client?.close();
            } catch (_) {}

            resolve(result);
        };

        try {
            const host =
                apnsHost(environment);

            const topic =
                requiredEnvironmentValue(
                    'APNS_BUNDLE_ID'
                );

            client = http2.connect(
                `https://${host}`
            );

            client.on('error', (error) => {
                finish({
                    success: false,
                    status: statusCode,
                    reason: error.message,
                    deactivateToken: false
                });
            });

            request = client.request({
                ':method': 'POST',
                ':path':
                    `/3/device/${deviceToken}`,
                authorization:
                    `bearer ${getProviderToken()}`,
                'apns-topic': topic,
                'apns-push-type': 'alert',
                'apns-priority': '10',
                'apns-expiration': '0',
                'content-type':
                    'application/json'
            });

            request.setEncoding('utf8');

            request.on(
                'response',
                (headers) => {
                    statusCode =
                        Number(
                            headers[':status']
                        ) || 0;
                }
            );

            request.on('data', (chunk) => {
                responseBody += chunk;
            });

            request.on('error', (error) => {
                finish({
                    success: false,
                    status: statusCode,
                    reason: error.message,
                    deactivateToken: false
                });
            });

            request.on('end', () => {
                let parsed = {};

                if (responseBody) {
                    try {
                        parsed =
                            JSON.parse(
                                responseBody
                            );
                    } catch (_) {
                        parsed = {
                            reason:
                            responseBody
                        };
                    }
                }

                const reason =
                    parsed.reason || null;

                const deactivateToken =
                    statusCode === 410 ||
                    reason ===
                    'BadDeviceToken' ||
                    reason ===
                    'Unregistered' ||
                    reason ===
                    'DeviceTokenNotForTopic';

                finish({
                    success:
                        statusCode === 200,
                    status: statusCode,
                    reason,
                    deactivateToken
                });
            });

            const payload = {
                aps: {
                    alert: {
                        title,
                        body
                    },
                    sound: 'default',
                    badge
                },

                ...customData,

                type: notificationType,

                vendor_id:
                    Number(vendorId)
            };

            /*
             * Service-request notifications have request_id.
             * FamilyTree lead alerts have lead_id instead.
             */
            if (
                requestId !== null &&
                requestId !== undefined &&
                String(requestId).trim()
            ) {
                payload.request_id =
                    String(requestId);
            }

            request.end(
                JSON.stringify(payload)
            );
        } catch (error) {
            finish({
                success: false,
                status: statusCode,
                reason: error.message,
                deactivateToken: false
            });
        }
    });
}

module.exports = {
    sendVendorPush
};
