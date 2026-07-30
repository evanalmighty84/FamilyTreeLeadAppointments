// sendFamilyTreeLeadAlerts.js

"use strict";

require("dotenv").config();

let nodemailer = null;

try {
    nodemailer = require("nodemailer");
} catch (error) {
    console.warn(
        "⚠️ nodemailer is not installed. Email alerts will be disabled " +
        "until you run: npm install nodemailer"
    );
}

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

const {
    ZEPTOMAIL_FROM_NAME,
    ZEPTOMAIL_FROM_EMAIL,
    ZEPTOMAIL_SMTP_HOST,
    ZEPTOMAIL_SMTP_PORT,
    ZEPTOMAIL_SMTP_USER,
    ZEPTOMAIL_SMTP_PASSWORD
} = process.env;

const EMAIL_SMTP_HOST =
    cleanText(ZEPTOMAIL_SMTP_HOST);

const EMAIL_SMTP_PORT =
    Number(ZEPTOMAIL_SMTP_PORT || 587);

const EMAIL_SMTP_USER =
    cleanText(ZEPTOMAIL_SMTP_USER);

const EMAIL_SMTP_PASSWORD =
    cleanText(ZEPTOMAIL_SMTP_PASSWORD);

const EMAIL_FROM_ADDRESS =
    cleanText(ZEPTOMAIL_FROM_EMAIL);

const EMAIL_FROM_NAME =
    cleanText(ZEPTOMAIL_FROM_NAME) ||
    "Clubhouse Links";

const EMAIL_SMTP_SECURE =
    EMAIL_SMTP_PORT === 465;

let emailTransporter = null;

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

function emailAlertsConfigured() {
    return Boolean(
        nodemailer &&
        EMAIL_SMTP_HOST &&
        EMAIL_SMTP_USER &&
        EMAIL_SMTP_PASSWORD &&
        EMAIL_FROM_ADDRESS
    );
}

function getEmailTransporter() {
    if (!emailAlertsConfigured()) {
        return null;
    }

    if (!emailTransporter) {
        emailTransporter =
            nodemailer.createTransport({
                host: EMAIL_SMTP_HOST,
                port: EMAIL_SMTP_PORT,
                secure: EMAIL_SMTP_SECURE,
                auth: {
                    user: EMAIL_SMTP_USER,
                    pass: EMAIL_SMTP_PASSWORD
                }
            });
    }

    return emailTransporter;
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
 * The Map is keyed by the normalized users.phone_number so the email
 * recipient can be matched against familytreenow.professionalnumbertocall.
 *
 * Email is an ADDITIONAL channel. It does not remove the recipient from
 * either the existing APNs or Twilio paths.
 */
async function loadEmailAlertDirectory() {
    try {
        const { rows } = await pool.query(`
            SELECT
                id AS user_id,
                name,
                company_name,
                email,
                phone_number

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
                    BTRIM(phone_number),
                    ''
                  ) IS NOT NULL

            ORDER BY id ASC
        `);

        const usersByPhone =
            new Map();

        const usersById =
            new Map();

        for (const row of rows) {
            const userId =
                Number(row.user_id);

            const normalizedPhone =
                normalizePhone(
                    row.phone_number
                );

            const email =
                cleanText(row.email);

            if (
                !userId ||
                !normalizedPhone ||
                !email
            ) {
                continue;
            }

            const user = {
                userId,
                name:
                    cleanText(row.name),
                companyName:
                    cleanText(row.company_name),
                email,
                phone:
                row.phone_number,
                normalizedPhone
            };

            usersById.set(
                userId,
                user
            );

            const phoneMatches =
                usersByPhone.get(
                    normalizedPhone
                ) || [];

            phoneMatches.push(user);

            usersByPhone.set(
                normalizedPhone,
                phoneMatches
            );
        }

        return {
            usersById,
            usersByPhone
        };
    } catch (error) {
        if (error?.code === "42703") {
            console.warn(
                "⚠️ users.alert_email does not exist yet. " +
                "Email alerts are disabled until the migration is run."
            );

            return {
                usersById: new Map(),
                usersByPhone: new Map()
            };
        }

        throw error;
    }
}

function buildLeadEmailSubject(lead) {
    const leadType =
        cleanText(lead.lead_type) ||
        "Home Service";

    const location =
        [
            cleanText(lead.city),
            cleanText(lead.state)
        ]
            .filter(Boolean)
            .join(", ");

    return truncate(
        location
            ? `New ${leadType} Lead in ${location}`
            : `New ${leadType} Lead`,
        150
    );
}

function buildLeadEmailContent(
    lead,
    recipient
) {
    const recipientName =
        cleanText(recipient.name) ||
        cleanText(recipient.companyName) ||
        "there";

    const leadName =
        cleanText(lead.name) ||
        "Not provided";

    const leadPhone =
        cleanText(lead.phone) ||
        "Not provided";

    const leadType =
        cleanText(lead.lead_type) ||
        "Home Service";

    const location =
        [
            cleanText(lead.city),
            cleanText(lead.state)
        ]
            .filter(Boolean)
            .join(", ") ||
        "Not provided";

    const address =
        cleanText(lead.physical_address) ||
        cleanText(lead.location) ||
        "Not provided";

    const description =
        cleanText(lead.description) ||
        "No description was provided.";

    const text = [
        `Hello ${recipientName},`,
        "",
        "A new FamilyTreeNow lead is available for you.",
        "",
        `Lead: ${leadName}`,
        `Phone: ${leadPhone}`,
        `Lead type: ${leadType}`,
        `Location: ${location}`,
        `Address: ${address}`,
        "",
        "Description:",
        description,
        "",
        "Clubhouse Links"
    ].join("\n");

    const html = `
        <div style="max-width:680px;margin:0 auto;padding:28px 20px;font-family:Verdana,Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#111827;">
            <h2 style="margin:0 0 18px;">New ${escapeHtml(leadType)} Lead</h2>

            <p>Hello ${escapeHtml(recipientName)},</p>

            <p>
                A new FamilyTreeNow lead is available for you.
            </p>

            <table style="width:100%;border-collapse:collapse;margin:20px 0;">
                <tr>
                    <td style="padding:8px 0;font-weight:bold;vertical-align:top;">Lead</td>
                    <td style="padding:8px 0;">${escapeHtml(leadName)}</td>
                </tr>
                <tr>
                    <td style="padding:8px 0;font-weight:bold;vertical-align:top;">Phone</td>
                    <td style="padding:8px 0;">
                        ${
        leadPhone !== "Not provided"
            ? `<a href="tel:${escapeHtml(leadPhone)}">${escapeHtml(leadPhone)}</a>`
            : escapeHtml(leadPhone)
    }
                    </td>
                </tr>
                <tr>
                    <td style="padding:8px 0;font-weight:bold;vertical-align:top;">Lead type</td>
                    <td style="padding:8px 0;">${escapeHtml(leadType)}</td>
                </tr>
                <tr>
                    <td style="padding:8px 0;font-weight:bold;vertical-align:top;">Location</td>
                    <td style="padding:8px 0;">${escapeHtml(location)}</td>
                </tr>
                <tr>
                    <td style="padding:8px 0;font-weight:bold;vertical-align:top;">Address</td>
                    <td style="padding:8px 0;">${escapeHtml(address)}</td>
                </tr>
            </table>

            <div style="padding:16px;background:#f3f4f6;border-radius:10px;">
                <strong>Description</strong>
                <div style="margin-top:8px;white-space:pre-wrap;">${escapeHtml(description)}</div>
            </div>

            <p style="margin-top:24px;">Clubhouse Links</p>
        </div>
    `;

    return {
        subject:
            buildLeadEmailSubject(lead),
        text,
        html
    };
}

async function sendLeadEmailToUser(
    lead,
    recipient
) {
    const transporter =
        getEmailTransporter();

    if (!transporter) {
        return {
            channel: "email",
            success: false,
            skipped: true,
            userId: recipient.userId,
            email: recipient.email,
            reason: "email_not_configured"
        };
    }

    const content =
        buildLeadEmailContent(
            lead,
            recipient
        );

    const info =
        await transporter.sendMail({
            from: {
                name: EMAIL_FROM_NAME,
                address: EMAIL_FROM_ADDRESS
            },
            to: recipient.email,
            subject: content.subject,
            text: content.text,
            html: content.html
        });

    console.log(
        `✅ Email delivered for lead ${lead.id} to ` +
        `${recipient.email} (users.id=${recipient.userId})`
    );

    return {
        channel: "email",
        success: true,
        skipped: false,
        userId: recipient.userId,
        email: recipient.email,
        messageId:
            info?.messageId || null
    };
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
    vendor
) {
    if (!vendor.devices.length) {
        console.log(
            `⚠️ ${vendor.companyName} matches an HOA vendor, ` +
            "but has no active APNs device."
        );

        return [];
    }

    const title =
        buildNotificationTitle(lead);

    const body =
        buildNotificationBody(lead);

    console.log(
        `🔔 Sending HOA vendor push to ` +
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

                            /*
                             * Do not pass requestId.
                             * This is not a hoa_service_requests row.
                             */
                            requestId: null,

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
                            `✅ APNs delivered lead ${lead.id} ` +
                            `to ${vendor.companyName}, ` +
                            `device ${device.id}`
                        );
                    } else {
                        console.error(
                            `❌ APNs failed for lead ${lead.id}:`,
                            {
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
            usersByPhone: emailAlertUsersByPhone
        } =
            await loadEmailAlertDirectory();

        console.log(
            `📧 Loaded ${emailAlertUsersById.size} user(s) ` +
            "with alert_email = TRUE"
        );

        if (emailAlertsConfigured()) {
            console.log(
                `✅ Email alert channel is configured through ` +
                `${EMAIL_SMTP_HOST}:${EMAIL_SMTP_PORT}`
            );
        } else {
            console.log(
                "⚠️ Email alert channel is not fully configured. " +
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

              AND scraped_at >=
                  NOW() - INTERVAL '40 days'

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
        `);

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
             * A lead may contain multiple destination companies.
             *
             * HOA vendor matches are removed from the Twilio list
             * and routed to APNs instead.
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

                const emailMatches =
                    emailAlertUsersByPhone.get(
                        normalizedPhone
                    ) || [];

                for (
                    const emailUser
                    of emailMatches
                    ) {
                    const emailKey =
                        cleanText(
                            emailUser.email
                        ).toLowerCase();

                    if (!emailKey) {
                        continue;
                    }

                    if (
                        !matchedEmailUsers.has(
                            emailKey
                        )
                    ) {
                        matchedEmailUsers.set(
                            emailKey,
                            emailUser
                        );

                        console.log(
                            `📧 ${originalPhone} matches users.id=` +
                            `${emailUser.userId} (${emailUser.email}) — ` +
                            "adding email alert"
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
                    const vendorResults =
                        await sendLeadPushToVendor(
                            lead,
                            vendor
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
             * Email is an additional alert channel. A recipient can receive
             * email and still continue through the existing APNs/Twilio logic.
             */
            const emailResults = [];

            if (matchedEmailUsers.size) {
                if (!emailAlertsConfigured()) {
                    console.log(
                        `⚠️ Lead ${lead.id} matched ` +
                        `${matchedEmailUsers.size} email recipient(s), ` +
                        "but SMTP email alerts are not configured."
                    );
                } else {
                    for (
                        const emailUser
                        of matchedEmailUsers.values()
                        ) {
                        try {
                            const emailResult =
                                await sendLeadEmailToUser(
                                    lead,
                                    emailUser
                                );

                            emailResults.push(
                                emailResult
                            );
                        } catch (error) {
                            console.error(
                                `💥 Email error for lead ${lead.id}, ` +
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
                                reason:
                                error.message
                            });
                        }
                    }
                }
            }

            const successfulEmails =
                emailResults.filter(
                    (emailResult) =>
                        emailResult.success === true
                );

            /*
             * Continue using the existing Twilio endpoint for
             * destination numbers that are not HOA vendors.
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

                    console.log(
                        "🧪 FULL TWILIO API RESPONSE:"
                    );

                    console.dir(
                        twilioApiResult?.data,
                        {
                            depth: null
                        }
                    );

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