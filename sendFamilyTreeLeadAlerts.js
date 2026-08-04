// sendFamilyTreeLeadAlerts.js

"use strict";

require("dotenv").config();

const pool = require("./db/db.js");

const {
    postLeadAlert
} = require("./leadAlertClient");

const {
    sendVendorPush
} = require("./services/apnsService");

const BASE_URL =
    process.env.NODE_ENV === "production"
        ? "https://crm-function-app-5d4de511071d.herokuapp.com/server/crm_function"
        : "http://localhost:5000/server/crm_function";

const PROD_ALERT_URL =
    process.env.LEAD_ALERT_URL ||
    `${BASE_URL}/api/smsqueue/alert-lead`;

const FAMILYTREE_EMAIL_ALERT_URL =
    process.env.FAMILYTREE_EMAIL_ALERT_URL ||
    "https://crm-function-app-5d4de511071d.herokuapp.com/server/lead_function/api/leads/send-familytree-alerts";

const FTN_ALERT_SECRET =
    String(process.env.FTN_ALERT_SECRET || "").trim();

/*
 * Optional one-run filters:
 *
 * ONLY_COMPANY limits processing to an exact company_name array value.
 * LEAD_LOOKBACK_DAYS defaults to 10. Set it to 0 to include all history.
 */
const ONLY_COMPANY =
    String(process.env.ONLY_COMPANY || "").trim();

const parsedLeadLookbackDays =
    Number.parseInt(
        process.env.LEAD_LOOKBACK_DAYS || "10",
        10
    );

const LEAD_LOOKBACK_DAYS =
    Number.isInteger(parsedLeadLookbackDays) &&
    parsedLeadLookbackDays >= 0
        ? parsedLeadLookbackDays
        : 10;

/*
 * Compare phone numbers using the final 10 digits.
 *
 * This makes all of these match:
 *
 * 4807805775
 * 14807805775
 * (480) 780-5775
 * +1 480-780-5775
 */
function normalizePhone(value) {
    const digits =
        String(value || "")
            .replace(/\D/g, "");

    if (digits.length < 10) {
        return null;
    }

    return digits.slice(-10);
}

function normalizeCompanyName(value) {
    return cleanText(value)
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function asArray(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return [];
    }

    return [value];
}

function cleanText(value) {
    return String(value || "").trim();
}

function truncate(value, maximumLength) {
    const text = cleanText(value);

    if (text.length <= maximumLength) {
        return text;
    }

    return (
        text.slice(
            0,
            Math.max(0, maximumLength - 1)
        ).trimEnd() + "…"
    );
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/*
 * Load all active HOA vendors and their active APNs devices.
 *
 * The Map is keyed by the normalized vendor phone number.
 */
async function loadVendorPushDirectory() {
    const { rows } = await pool.query(`
        SELECT
            v.id AS vendor_id,
            v.company_name,
            v.phone AS vendor_phone,

            d.id AS device_id,
            d.device_token,

            COALESCE(
                    NULLIF(
                            BTRIM(d.apns_environment),
                            ''
                    ),
                    'production'
            ) AS apns_environment

        FROM hoa_vendors v

                 LEFT JOIN hoa_vendor_devices d
                           ON d.vendor_id = v.id
                               AND d.active = TRUE

        WHERE v.active = TRUE

          AND NULLIF(
                BTRIM(v.phone),
                ''
              ) IS NOT NULL

        ORDER BY
            v.id ASC,
            d.id ASC
    `);

    const vendorsById =
        new Map();

    const vendorsByPhone =
        new Map();

    for (const row of rows) {
        const vendorId =
            Number(row.vendor_id);

        const normalizedPhone =
            normalizePhone(
                row.vendor_phone
            );

        if (
            !vendorId ||
            !normalizedPhone
        ) {
            continue;
        }

        let vendor =
            vendorsById.get(vendorId);

        if (!vendor) {
            vendor = {
                vendorId,
                companyName:
                    cleanText(
                        row.company_name
                    ) ||
                    `Vendor ${vendorId}`,
                phone:
                row.vendor_phone,
                normalizedPhone,
                devices: []
            };

            vendorsById.set(
                vendorId,
                vendor
            );

            const phoneMatches =
                vendorsByPhone.get(
                    normalizedPhone
                ) || [];

            phoneMatches.push(vendor);

            vendorsByPhone.set(
                normalizedPhone,
                phoneMatches
            );
        }

        if (
            row.device_id &&
            cleanText(row.device_token)
        ) {
            const deviceAlreadyAdded =
                vendor.devices.some(
                    (device) =>
                        String(device.id) ===
                        String(row.device_id)
                );

            if (!deviceAlreadyAdded) {
                vendor.devices.push({
                    id: row.device_id,
                    deviceToken:
                    row.device_token,
                    environment:
                        row.apns_environment ||
                        "production"
                });
            }
        }
    }

    return {
        vendorsById,
        vendorsByPhone
    };
}

/*
 * Load users who explicitly enabled email lead alerts.
 *
 * Email routing is based on users.company_name matching the aligned
 * familytreenow.company_name entry. Phone-number matching is not used
 * for email delivery.
 */
async function loadEmailAlertDirectory() {
    try {
        const { rows } = await pool.query(`
            SELECT
                id AS user_id,
                name,
                company_name,
                email

            FROM users

            WHERE COALESCE(
                          alert_email,
                          FALSE
                  ) = TRUE

              AND NULLIF(
                    BTRIM(email),
                    ''
                  ) IS NOT NULL

              AND NULLIF(
                    BTRIM(company_name),
                    ''
                  ) IS NOT NULL

            ORDER BY id ASC
        `);

        const usersById =
            new Map();

        const usersByCompany =
            new Map();

        for (const row of rows) {
            const userId =
                Number(row.user_id);

            const companyName =
                cleanText(row.company_name);

            const normalizedCompanyName =
                normalizeCompanyName(
                    companyName
                );

            const email =
                cleanText(row.email);

            if (
                !userId ||
                !normalizedCompanyName ||
                !email
            ) {
                continue;
            }

            const user = {
                userId,
                name:
                    cleanText(row.name),
                companyName,
                normalizedCompanyName,
                email
            };

            usersById.set(
                userId,
                user
            );

            const companyMatches =
                usersByCompany.get(
                    normalizedCompanyName
                ) || [];

            companyMatches.push(user);

            usersByCompany.set(
                normalizedCompanyName,
                companyMatches
            );
        }

        return {
            usersById,
            usersByCompany
        };
    } catch (error) {
        if (error?.code === "42703") {
            console.warn(
                "⚠️ users.alert_email does not exist yet. " +
                "Email alerts are disabled until the migration is run."
            );

            return {
                usersById: new Map(),
                usersByCompany: new Map()
            };
        }

        throw error;
    }
}

function herokuEmailEndpointConfigured() {
    return Boolean(
        cleanText(FAMILYTREE_EMAIL_ALERT_URL) &&
        FTN_ALERT_SECRET
    );
}

function emailEndpointReportedSuccess(data) {
    if (!data || typeof data !== "object") {
        return false;
    }

    if (
        data.sent === true ||
        Number(data.emails_sent || 0) > 0
    ) {
        return true;
    }

    if (
        Array.isArray(data.results) &&
        data.results.some(
            (result) =>
                result?.sent === true ||
                result?.success === true
        )
    ) {
        return true;
    }

    return data.success === true;
}

async function sendLeadEmailThroughHeroku(
    lead,
    recipient
) {
    if (!herokuEmailEndpointConfigured()) {
        return {
            channel: "email",
            success: false,
            skipped: true,
            userId: recipient.userId,
            email: recipient.email,
            companyName: recipient.companyName,
            reason: "heroku_email_endpoint_not_configured"
        };
    }

    if (typeof fetch !== "function") {
        throw new Error(
            "Global fetch is unavailable. Use Node.js 18 or newer."
        );
    }

    const response =
        await fetch(
            FAMILYTREE_EMAIL_ALERT_URL,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "x-ftn-alert-secret":
                    FTN_ALERT_SECRET
                },
                body: JSON.stringify({
                    lead_id:
                    lead.id,
                    user_id:
                    recipient.userId,
                    company_name:
                    recipient.companyName
                })
            }
        );

    const responseText =
        await response.text();

    let data = null;

    if (responseText) {
        try {
            data =
                JSON.parse(responseText);
        } catch (_) {
            data = {
                raw_response:
                responseText
            };
        }
    }

    if (!response.ok) {
        throw new Error(
            `Heroku email endpoint returned ${response.status}: ` +
            `${responseText || response.statusText}`
        );
    }

    const success =
        emailEndpointReportedSuccess(data);

    console.log(
        `📧 Heroku email endpoint result for lead ${lead.id}, ` +
        `users.id=${recipient.userId}, ` +
        `company=${recipient.companyName}:`,
        data
    );

    return {
        channel: "email",
        success,
        skipped: false,
        userId: recipient.userId,
        email: recipient.email,
        companyName: recipient.companyName,
        status: response.status,
        data,
        reason:
            success
                ? null
                : "endpoint_did_not_report_success"
    };
}

/*
 * Create or refresh the vendor inbox item before sending APNs.
 *
 * The unique key on (source, source_lead_id, vendor_id) makes this safe
 * to run again: retries reuse the same inbox row instead of creating a
 * duplicate request.
 */
async function createOrUpdateVendorInboxRequest(
    lead,
    vendor
) {
    const service =
        cleanText(lead.lead_type) ||
        "Home Service";

    const subService =
        cleanText(lead.lead_type) ||
        null;

    const message =
        cleanText(lead.description) ||
        "New homeowner lead from FamilyTreeNow.";

    const leadAddress =
        cleanText(lead.physical_address) ||
        cleanText(lead.location) ||
        null;

    const { rows } = await pool.query(
        `
            INSERT INTO hoa_service_requests (
                resident_id,
                vendor_id,
                service,
                sub_service,
                message,
                status,
                source,
                source_lead_id,
                lead_name,
                lead_phone,
                lead_address,
                lead_city,
                lead_state
            )
            VALUES (
                NULL,
                $1,
                $2,
                $3,
                $4,
                'new',
                'familytreenow',
                $5,
                $6,
                $7,
                $8,
                $9,
                $10
            )
            ON CONFLICT (
                source,
                source_lead_id,
                vendor_id
            )
            DO UPDATE SET
                service = EXCLUDED.service,
                sub_service = EXCLUDED.sub_service,
                message = EXCLUDED.message,
                lead_name = EXCLUDED.lead_name,
                lead_phone = EXCLUDED.lead_phone,
                lead_address = EXCLUDED.lead_address,
                lead_city = EXCLUDED.lead_city,
                lead_state = EXCLUDED.lead_state
            RETURNING
                id,
                vendor_id,
                service,
                sub_service,
                status,
                source,
                source_lead_id,
                created_at
        `,
        [
            vendor.vendorId,
            service,
            subService,
            message,
            lead.id,
            cleanText(lead.name) || "Homeowner",
            cleanText(lead.phone) || null,
            leadAddress,
            cleanText(lead.city) || null,
            cleanText(lead.state) || null
        ]
    );

    return rows[0];
}

function buildNotificationTitle(lead) {
    const leadType =
        cleanText(lead.lead_type) ||
        "Home Service";

    return truncate(
        `New ${leadType} Lead`,
        70
    );
}

function buildNotificationBody(lead) {
    const leadType =
        cleanText(lead.lead_type) ||
        "home service";

    const city =
        cleanText(lead.city);

    const state =
        cleanText(lead.state);

    const location =
        [city, state]
            .filter(Boolean)
            .join(", ");

    if (location) {
        return truncate(
            `A new ${leadType} lead is available in ${location}. Open Clubhouse Links to review the alert.`,
            170
        );
    }

    return truncate(
        `A new ${leadType} lead is available. Open Clubhouse Links to review the alert.`,
        170
    );
}

/*
 * Send one FamilyTree lead notification to all active
 * devices belonging to the matched vendor.
 */
async function sendLeadPushToVendor(
    lead,
    vendor,
    request
) {
    if (!vendor.devices.length) {
        console.log(
            `⚠️ ${vendor.companyName} matches an HOA vendor, ` +
            "but has no active APNs device. " +
            `Inbox request ${request.id} was still created.`
        );

        return [];
    }

    const title =
        buildNotificationTitle(lead);

    const body =
        buildNotificationBody(lead);

    console.log(
        `🔔 Sending inbox request ${request.id} to ` +
        `${vendor.companyName} ` +
        `(${vendor.devices.length} device(s))`
    );

    const results =
        await Promise.all(
            vendor.devices.map(
                async (device) => {
                    const pushResult =
                        await sendVendorPush({
                            deviceToken:
                            device.deviceToken,

                            environment:
                            device.environment,

                            title,
                            body,

                            requestId:
                                String(request.id),

                            vendorId:
                            vendor.vendorId,

                            badge: 1,

                            notificationType:
                                "family_tree_lead",

                            customData: {
                                lead_id:
                                    String(lead.id),

                                lead_type:
                                    cleanText(
                                        lead.lead_type
                                    ),

                                city:
                                    cleanText(
                                        lead.city
                                    ),

                                state:
                                    cleanText(
                                        lead.state
                                    )
                            }
                        });

                    if (
                        pushResult.deactivateToken
                    ) {
                        await pool.query(
                            `
                                UPDATE hoa_vendor_devices
                                SET
                                    active = FALSE,
                                    updated_at = NOW()
                                WHERE id = $1
                            `,
                            [device.id]
                        );
                    }

                    if (pushResult.success) {
                        console.log(
                            `✅ APNs delivered lead ${lead.id}, ` +
                            `inbox request ${request.id}, ` +
                            `to ${vendor.companyName}, ` +
                            `device ${device.id}`
                        );
                    } else {
                        console.error(
                            `❌ APNs failed for lead ${lead.id}:`,
                            {
                                requestId:
                                request.id,

                                vendorId:
                                vendor.vendorId,

                                companyName:
                                vendor.companyName,

                                deviceId:
                                device.id,

                                status:
                                pushResult.status,

                                reason:
                                pushResult.reason
                            }
                        );
                    }

                    return {
                        channel: "apns",

                        requestId:
                            String(request.id),

                        vendorId:
                        vendor.vendorId,

                        companyName:
                        vendor.companyName,

                        deviceId:
                        device.id,

                        ...pushResult
                    };
                }
            )
        );

    return results;
}

/*
 * Preserve array alignment when vendor recipients are removed
 * from the Twilio payload.
 */
function buildSmsPayload(
    lead,
    smsRecipients
) {
    const payload = {
        ...lead,

        professionalnumbertocall:
            smsRecipients.map(
                (recipient) =>
                    recipient.phone
            ),

        company_name:
            smsRecipients.map(
                (recipient) =>
                    recipient.companyName
            )
    };

    if (
        Array.isArray(
            lead.networkingsource
        )
    ) {
        payload.networkingsource =
            smsRecipients.map(
                (recipient) =>
                    recipient.networkingSource
            );
    }

    return payload;
}

(async () => {
    console.log(
        "🚀 Starting FamilyTreeNow Lead Alert job"
    );

    console.log(
        "🔧 Using LEAD ALERT URL:",
        PROD_ALERT_URL
    );

    console.log(
        "🗓️ Lead lookback:",
        LEAD_LOOKBACK_DAYS === 0
            ? "all history"
            : `${LEAD_LOOKBACK_DAYS} day(s)`
    );

    if (ONLY_COMPANY) {
        console.log(
            "🏢 Company-only filter:",
            ONLY_COMPANY
        );
    }

    try {
        await pool.query(
            "SELECT NOW()"
        );

        console.log(
            "✅ Successfully connected to PostgreSQL database"
        );

        const {
            vendorsById,
            vendorsByPhone
        } =
            await loadVendorPushDirectory();

        console.log(
            `📱 Loaded ${vendorsById.size} active HOA vendor(s) ` +
            "for push-notification matching"
        );

        const {
            usersById: emailAlertUsersById,
            usersByCompany: emailAlertUsersByCompany
        } =
            await loadEmailAlertDirectory();

        console.log(
            `📧 Loaded ${emailAlertUsersById.size} user(s) ` +
            "with alert_email = TRUE"
        );

        if (herokuEmailEndpointConfigured()) {
            console.log(
                "✅ Heroku email alert endpoint is configured:",
                FAMILYTREE_EMAIL_ALERT_URL
            );
        } else {
            console.log(
                "⚠️ Heroku email alert endpoint is not fully configured. " +
                "Existing APNs and Twilio delivery will continue normally."
            );
        }

        const {
            rows: leads
        } = await pool.query(`
            SELECT
                id,
                author AS name,
                phone,
                lead_type,
                city,
                state,
                description,
                location,
                physical_address,
                company_name,
                professionalnumbertocall,
                networkingsource

            FROM familytreenow

            WHERE NULLIF(
                    BTRIM(phone),
                    ''
                  ) IS NOT NULL

              AND (
                $1::integer = 0
                OR scraped_at >=
                   NOW() - ($1::integer * INTERVAL '1 day')
                )

              AND COALESCE(
                          lead_sent,
                          FALSE
                  ) = FALSE

              AND UPPER(
                          BTRIM(state)
                  ) = 'TX'

              AND EXISTS (
                SELECT 1

                FROM unnest(
                             COALESCE(
                                     company_name,
                                     ARRAY[]::text[]
                             )
                     ) AS company(value)

                WHERE NULLIF(
                              BTRIM(company.value),
                              ''
                      ) IS NOT NULL
            )

              AND (
                NULLIF(BTRIM($2::text), '') IS NULL
                    OR EXISTS (
                    SELECT 1
                    FROM unnest(
                                 COALESCE(
                                         company_name,
                                         ARRAY[]::text[]
                                 )
                         ) AS filtered_company(value)
                    WHERE LOWER(BTRIM(filtered_company.value)) =
                          LOWER(BTRIM($2::text))
                )
                )

              AND EXISTS (
                SELECT 1

                FROM unnest(
                             COALESCE(
                                     professionalnumbertocall,
                                     ARRAY[]::text[]
                             )
                     ) AS professional(value)

                WHERE LENGTH(
                              regexp_replace(
                                      COALESCE(
                                              professional.value,
                                              ''
                                      ),
                                      '[^0-9]',
                                      '',
                                      'g'
                              )
                      ) >= 10
            )

            ORDER BY id ASC
        `, [
            LEAD_LOOKBACK_DAYS,
            ONLY_COMPANY
        ]);

        if (!leads.length) {
            console.log(
                "✅ No eligible FamilyTreeNow leads to send."
            );

            return;
        }

        console.log(
            `📋 Found ${leads.length} eligible unsent lead(s)`
        );

        for (const lead of leads) {
            console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 Processing lead ${lead.id}
👤 ${lead.name}
📞 ${lead.phone}
🏷️ ${lead.lead_type}
📍 ${lead.city}, ${lead.state}
🏢 ${JSON.stringify(lead.company_name)}
☎️ ${JSON.stringify(lead.professionalnumbertocall)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            `);

            const professionalPhones =
                asArray(
                    lead.professionalnumbertocall
                );

            const companyNames =
                asArray(
                    lead.company_name
                );

            const networkingSources =
                asArray(
                    lead.networkingsource
                );

            /*
             * Each aligned company/phone destination follows three layers:
             *
             * 1. A professional phone matching hoa_vendors receives APNs.
             * 2. A company matching users.company_name with alert_email = TRUE
             *    receives email through the Heroku endpoint. This is independent
             *    of APNs and Twilio.
             * 3. Twilio receives only professional phones that did not match
             *    an HOA vendor in layer 1.
             */
            const matchedVendors =
                new Map();

            const matchedEmailUsers =
                new Map();

            const smsRecipients = [];

            const seenSmsPhones =
                new Set();

            for (
                let index = 0;
                index <
                professionalPhones.length;
                index += 1
            ) {
                const originalPhone =
                    professionalPhones[index];

                const normalizedPhone =
                    normalizePhone(
                        originalPhone
                    );

                if (!normalizedPhone) {
                    console.log(
                        `⚠️ Skipping invalid professional phone: ` +
                        `${originalPhone}`
                    );

                    continue;
                }

                const originalCompanyName =
                    cleanText(
                        companyNames[index]
                    );

                const normalizedCompanyName =
                    normalizeCompanyName(
                        originalCompanyName
                    );

                const emailMatches =
                    normalizedCompanyName
                        ? emailAlertUsersByCompany.get(
                        normalizedCompanyName
                    ) || []
                        : [];

                for (
                    const emailUser
                    of emailMatches
                    ) {
                    if (
                        !matchedEmailUsers.has(
                            emailUser.userId
                        )
                    ) {
                        matchedEmailUsers.set(
                            emailUser.userId,
                            emailUser
                        );

                        console.log(
                            `📧 ${originalCompanyName} matches ` +
                            `users.id=${emailUser.userId} ` +
                            `(${emailUser.email}) with ` +
                            `alert_email = TRUE — adding Heroku email alert`
                        );
                    }
                }

                const vendorMatches =
                    vendorsByPhone.get(
                        normalizedPhone
                    ) || [];

                if (vendorMatches.length) {
                    for (
                        const vendor
                        of vendorMatches
                        ) {
                        matchedVendors.set(
                            vendor.vendorId,
                            vendor
                        );

                        console.log(
                            `🔀 ${originalPhone} matches ` +
                            `hoa_vendors.id=${vendor.vendorId} ` +
                            `(${vendor.companyName}) — using APNs`
                        );
                    }

                    /*
                     * Do not add this number to smsRecipients.
                     * This prevents Twilio from texting the vendor.
                     */
                    continue;
                }

                if (
                    seenSmsPhones.has(
                        normalizedPhone
                    )
                ) {
                    continue;
                }

                seenSmsPhones.add(
                    normalizedPhone
                );

                smsRecipients.push({
                    phone:
                    originalPhone,

                    companyName:
                        companyNames[index] ||
                        "",

                    networkingSource:
                        networkingSources[index] ||
                        ""
                });
            }

            /*
             * Send push notifications to matched HOA vendors.
             */
            const allPushResults = [];

            for (
                const vendor
                of matchedVendors.values()
                ) {
                try {
                    const request =
                        await createOrUpdateVendorInboxRequest(
                            lead,
                            vendor
                        );

                    console.log(
                        `✅ Vendor inbox request ${request.id} ` +
                        `ready for ${vendor.companyName}`
                    );

                    const vendorResults =
                        await sendLeadPushToVendor(
                            lead,
                            vendor,
                            request
                        );

                    allPushResults.push(
                        ...vendorResults
                    );
                } catch (error) {
                    console.error(
                        `💥 Push error for vendor ` +
                        `${vendor.vendorId}:`,
                        error.message
                    );
                }
            }

            const successfulPushes =
                allPushResults.filter(
                    (pushResult) =>
                        pushResult.success === true
                );

            /*
             * Email is an independent second layer. Company-name matches with
             * users.alert_email = TRUE call the Heroku email endpoint whether
             * or not the same destination also matched an HOA vendor.
             */
            const emailResults = [];

            for (
                const emailUser
                of matchedEmailUsers.values()
                ) {
                try {
                    const emailResult =
                        await sendLeadEmailThroughHeroku(
                            lead,
                            emailUser
                        );

                    emailResults.push(
                        emailResult
                    );
                } catch (error) {
                    console.error(
                        `💥 Heroku email error for lead ${lead.id}, ` +
                        `users.id=${emailUser.userId}, ` +
                        `${emailUser.email}:`,
                        error.message
                    );

                    emailResults.push({
                        channel: "email",
                        success: false,
                        skipped: false,
                        userId:
                        emailUser.userId,
                        email:
                        emailUser.email,
                        companyName:
                        emailUser.companyName,
                        reason:
                        error.message
                    });
                }
            }

            const successfulEmails =
                emailResults.filter(
                    (emailResult) =>
                        emailResult.success === true
                );

            /*
             * Third layer: use the existing Twilio endpoint only for
             * destination numbers that did not match hoa_vendors.
             */
            let twilioApiResult = null;
            let twilioResults = [];

            if (smsRecipients.length) {
                const smsPayload =
                    buildSmsPayload(
                        lead,
                        smsRecipients
                    );

                console.log(
                    `📲 Sending ${smsRecipients.length} ` +
                    "non-vendor destination(s) through Twilio"
                );

                console.log(
                    "🏷️ RAW lead_type:",
                    JSON.stringify(
                        lead.lead_type
                    )
                );

                if (
                    String(
                        lead.lead_type || ""
                    )
                        .trim()
                        .toLowerCase()
                        .includes("prospect")
                ) {
                    console.log(
                        "🏢 Prospect payload:"
                    );

                    console.log(
                        "   Company:",
                        smsPayload.company_name
                    );

                    console.log(
                        "   Pro Phone:",
                        smsPayload
                            .professionalnumbertocall
                    );

                    console.log(
                        "   Networking Source:",
                        smsPayload
                            .networkingsource
                    );
                }

                try {
                    twilioApiResult =
                        await postLeadAlert(
                            smsPayload
                        );

                    console.log("🧪 FULL TWILIO API RESULT:");

                    console.dir(
                        twilioApiResult,
                        { depth: null }
                    );

                    if (!twilioApiResult?.ok) {
                        console.error(
                            `❌ Twilio request failed for lead ${lead.id}:`,
                            twilioApiResult?.error ||
                            twilioApiResult?.data ||
                            twilioApiResult
                        );
                    }

                    twilioResults =
                        Array.isArray(
                            twilioApiResult
                                ?.data
                                ?.results
                        )
                            ? twilioApiResult
                                .data
                                .results
                            : [];
                } catch (error) {
                    console.error(
                        `💥 Twilio API error for lead ` +
                        `${lead.id}:`,
                        error.message
                    );
                }
            } else {
                console.log(
                    "🔕 No non-vendor numbers remain for Twilio."
                );
            }

            const seenResponsePhones =
                new Set();

            for (
                const responseResult
                of twilioResults
                ) {
                const responsePhone =
                    responseResult?.destination_phone ||
                    responseResult?.phone ||
                    null;

                if (
                    responsePhone &&
                    seenResponsePhones.has(
                        responsePhone
                    )
                ) {
                    continue;
                }

                if (responsePhone) {
                    seenResponsePhones.add(
                        responsePhone
                    );
                }

                console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━
🏢 Company: ${responseResult.company_name || "N/A"}
🆔 User ID: ${responseResult.userId || "N/A"}
📞 Phone: ${responsePhone || "N/A"}
📤 Sent: ${responseResult.sent ? "YES" : "NO"}
🧾 SID: ${responseResult.sid || "N/A"}
━━━━━━━━━━━━━━━━━━━━━━━━━━
                `);
            }

            const successfulTwilioSends =
                twilioResults.filter(
                    (responseResult) =>
                        responseResult?.sent === true
                );

            const twilioActuallySent =
                twilioApiResult?.ok === true &&
                successfulTwilioSends.length > 0;

            const successfulDeliveryCount =
                successfulPushes.length +
                successfulEmails.length +
                (
                    twilioActuallySent
                        ? successfulTwilioSends.length
                        : 0
                );

            const wasActuallySent =
                successfulDeliveryCount > 0;

            if (wasActuallySent) {
                await pool.query(
                    `
                        UPDATE familytreenow
                        SET lead_sent = TRUE
                        WHERE id = $1
                    `,
                    [lead.id]
                );

                console.log(
                    `✅ Marked lead ${lead.id} as sent: ` +
                    `${successfulPushes.length} APNs push(es), ` +
                    `${successfulTwilioSends.length} Twilio send(s), ` +
                    `${successfulEmails.length} email alert(s)`
                );
            } else {
                await pool.query(
                    `
                        UPDATE familytreenow
                        SET lead_sent = FALSE
                        WHERE id = $1
                    `,
                    [lead.id]
                );

                console.log(
                    `⚠️ Lead ${lead.id} had no successful ` +
                    "APNs, Twilio, or email delivery — keeping " +
                    "lead_sent = FALSE"
                );
            }
        }

        console.log(
            "🏁 Lead alert job complete."
        );
    } catch (error) {
        console.error(
            "💥 Fatal error:",
            error
        );

        process.exitCode = 1;
    } finally {
        try {
            await pool.end();
        } catch (_) {}
    }
})();