// testStaticFtnVendorPush.js
//
// PURPOSE:
// - Simulates one FamilyTreeNow lead.
// - Matches professionalnumbertocall against hoa_vendors.phone.
// - Creates a real hoa_service_requests inbox row.
// - Sends an APNs notification using that real request ID.
// - Does not insert into or update familytreenow.
// - Does not send a Twilio text.
//
// RUN:
//   node testStaticFtnVendorPush.js
//
// REQUIRED ENVIRONMENT VARIABLES:
//   APNS_BUNDLE_ID
//   APPLE_TEAM_ID
//   APNS_KEY_ID
//   APNS_PRIVATE_KEY

"use strict";

require("dotenv").config();

const pool = require("./db/db.js");
const { sendVendorPush } = require("./services/apnsService");

const fakeLead = {
    id: 4602,

    name: "Harold Devoz Jr",
    phone: "(469) 951-9850",

    lead_type: "landscaping,plumber",
    city: "Allen",
    state: "TX",

    description:
        "Have an issue with our irrigation sprinkler system. " +
        "The previous owner extended our backyard patio over the built-in sprinkler system. " +
        "Somehow one of the pipes got disconnected and sprung a water leak. " +
        "There is no way for us to get to it as it is underneath concrete. " +
        "I assume we need it re-routed. Any recommendations? Any cost estimates?",

    location: null,
    physical_address: null,

    company_name: [
        "Aspen Tree Service",
        "3G Plumbing"
    ],

    professionalnumbertocall: [
        "4807805775",
        "214-356-6967"
    ],

    networkingsource: null
};

function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");

    if (digits.length < 10) {
        return null;
    }

    return digits.slice(-10);
}

function cleanText(value) {
    return String(value || "").trim();
}

function truncate(value, maximumLength) {
    const text = cleanText(value);

    if (text.length <= maximumLength) {
        return text;
    }

    return `${text.slice(0, maximumLength - 1).trimEnd()}…`;
}

async function findVendorAndDevicesByPhone(phone) {
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
        throw new Error(`Invalid professional phone number: ${phone}`);
    }

    const { rows } = await pool.query(
        `
            SELECT
                v.id AS vendor_id,
                v.company_name AS database_company_name,
                v.phone AS vendor_phone,

                d.id AS device_id,
                d.device_token,
                COALESCE(
                    NULLIF(BTRIM(d.apns_environment), ''),
                    'production'
                ) AS apns_environment

            FROM hoa_vendors v

            LEFT JOIN hoa_vendor_devices d
              ON d.vendor_id = v.id
             AND d.active = TRUE

            WHERE v.active = TRUE
              AND RIGHT(
                    regexp_replace(
                        COALESCE(v.phone, ''),
                        '[^0-9]',
                        '',
                        'g'
                    ),
                    10
                  ) = $1

            ORDER BY
                v.id ASC,
                d.id ASC
        `,
        [normalizedPhone]
    );

    return rows;
}

async function createInboxRequest({ lead, vendorId }) {
    const service =
        cleanText(lead.lead_type) || "Home Service";

    const subService =
        cleanText(lead.lead_type) || null;

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
                'familytreenow_test',
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
                created_at
        `,
        [
            vendorId,
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

async function runTest() {
    console.log("🚀 Starting static FTN vendor inbox + push test");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Fake company:", fakeLead.company_name[0]);
    console.log(
        "Professional number:",
        fakeLead.professionalnumbertocall[0]
    );
    console.log("Lead type:", fakeLead.lead_type);
    console.log("Location:", `${fakeLead.city}, ${fakeLead.state}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    await pool.query("SELECT NOW()");
    console.log("✅ Connected to PostgreSQL");

    const professionalPhone =
        fakeLead.professionalnumbertocall[0];

    const vendorRows =
        await findVendorAndDevicesByPhone(professionalPhone);

    if (!vendorRows.length) {
        throw new Error(
            `No active hoa_vendors record matched ${professionalPhone}`
        );
    }

    const vendorId = Number(vendorRows[0].vendor_id);
    const databaseCompanyName =
        vendorRows[0].database_company_name;

    console.log(`✅ Matched hoa_vendors.id=${vendorId}`);
    console.log(`🏢 Database company: ${databaseCompanyName}`);
    console.log(`🏷️ Static FTN company: ${fakeLead.company_name[0]}`);

    const request =
        await createInboxRequest({
            lead: fakeLead,
            vendorId
        });

    console.log(
        `✅ Created vendor inbox request ${request.id}`
    );

    const devices = vendorRows.filter(
        (row) =>
            row.device_id &&
            cleanText(row.device_token)
    );

    if (!devices.length) {
        throw new Error(
            `Vendor ${vendorId} has no active APNs device registrations. ` +
            `Inbox request ${request.id} was still created.`
        );
    }

    console.log(`📱 Found ${devices.length} active device(s)`);

    const title =
        truncate(`New ${fakeLead.lead_type} Lead`, 70);

    const body = truncate(
        `A new ${fakeLead.lead_type} lead is available in ` +
        `${fakeLead.city}, ${fakeLead.state}. ` +
        `Open Clubhouse Links to review it.`,
        170
    );

    let successfulPushCount = 0;

    for (const device of devices) {
        console.log(
            `🔔 Sending request ${request.id} to device ${device.device_id}`
        );

        const pushResult = await sendVendorPush({
            deviceToken: device.device_token,
            environment:
                device.apns_environment || "production",
            title,
            body,
            requestId: String(request.id),
            vendorId,
            badge: 1
        });

        console.log(
            `📨 APNs result for device ${device.device_id}:`
        );

        console.dir(pushResult, { depth: null });

        if (pushResult?.success === true) {
            successfulPushCount += 1;

            console.log(
                `✅ Push accepted for device ${device.device_id}`
            );
        } else {
            console.error(
                `❌ Push failed for device ${device.device_id}:`,
                {
                    status: pushResult?.status,
                    reason: pushResult?.reason
                }
            );
        }

        if (pushResult?.deactivateToken === true) {
            await pool.query(
                `
                    UPDATE hoa_vendor_devices
                    SET
                        active = FALSE,
                        updated_at = NOW()
                    WHERE id = $1
                `,
                [device.device_id]
            );

            console.log(
                `⚠️ Deactivated invalid device ${device.device_id}`
            );
        }
    }

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`Inbox request ID: ${request.id}`);
    console.log(`Pushes accepted: ${successfulPushCount}`);
    console.log(`Devices attempted: ${devices.length}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (successfulPushCount === 0) {
        throw new Error(
            `No APNs notifications were accepted. ` +
            `Inbox request ${request.id} was still created.`
        );
    }

    console.log(
        "✅ Static FTN vendor inbox + push test succeeded"
    );
}

(async () => {
    try {
        await runTest();
    } catch (error) {
        console.error("💥 Static FTN test failed:", error);
        process.exitCode = 1;
    } finally {
        try {
            await pool.end();
        } catch (error) {
            console.error(
                "Database shutdown error:",
                error.message
            );
        }
    }
})();
