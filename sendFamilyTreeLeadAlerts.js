// sendFamilyTreeLeadAlerts.js

"use strict";

require("dotenv").config();

const pool = require("./db/db.js");
const { postLeadAlert } = require("./leadAlertClient");

const BASE_URL =
    process.env.NODE_ENV === "production"
        ? "https://crm-function-app-5d4de511071d.herokuapp.com/server/crm_function"
        : "http://localhost:5000/server/crm_function";

(async () => {
    console.log(
        "🚀 Starting FamilyTreeNow Lead Alert job",
    );

    console.log(
        "🔧 Using LEAD ALERT URL:",
        process.env.LEAD_ALERT_URL,
    );

    const PROD_ALERT_URL =
        process.env.LEAD_ALERT_URL ||
        `${BASE_URL}/api/smsqueue/alert-lead`;

    try {
        // Confirm the database connection.
        await pool.query("SELECT NOW()");

        console.log(
            "✅ Successfully connected to PostgreSQL database",
        );

        /*
         * Fetch only leads that:
         *
         * 1. Have a homeowner phone number.
         * 2. Have at least one non-empty company_name.
         * 3. Have at least one professional number containing
         *    at least 10 digits.
         * 4. Have not already been sent.
         */
        const { rows: leads } = await pool.query(`
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
            WHERE NULLIF(BTRIM(phone), '') IS NOT NULL

              AND scraped_at >=
                  NOW() - INTERVAL '3 days'

              AND COALESCE(lead_sent, FALSE) = FALSE

              AND UPPER(BTRIM(state)) = 'TX'

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
                "✅ No eligible FamilyTreeNow leads to send.",
            );

            process.exit(0);
        }

        console.log(
            `📋 Found ${leads.length} eligible unsent lead(s)`,
        );

        for (const lead of leads) {
            console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 Sending alert for lead ${lead.id}
👤 ${lead.name}
📞 ${lead.phone}
🏷️ ${lead.lead_type}
📍 ${lead.city}, ${lead.state}
🏢 ${JSON.stringify(lead.company_name)}
☎️ ${JSON.stringify(lead.professionalnumbertocall)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            `);

            let payload = {
                ...lead,
            };

            console.log(
                "🏷️ RAW lead_type:",
                JSON.stringify(lead.lead_type),
            );

            /*
             * Preserve the existing prospect behavior.
             *
             * These values are already available from the main
             * SELECT, so another database query is unnecessary.
             */
            if (
                String(lead.lead_type || "")
                    .trim()
                    .toLowerCase()
                    .includes("prospect")
            ) {
                payload.company_name =
                    lead.company_name;

                payload.professionalnumbertocall =
                    lead.professionalnumbertocall;

                payload.networkingsource =
                    lead.networkingsource;

                console.log(
                    "🏢 Prospect override:",
                );

                console.log(
                    "   Company:",
                    lead.company_name,
                );

                console.log(
                    "   Pro Phone:",
                    lead.professionalnumbertocall,
                );

                console.log(
                    "   Networking Source:",
                    lead.networkingsource,
                );
            }

            let result;

            try {
                result = await postLeadAlert(payload);

                console.log(
                    "🧪 FULL API RESPONSE:",
                );

                console.dir(
                    result?.data,
                    {
                        depth: null,
                    },
                );
            } catch (error) {
                console.error(
                    `💥 API error for lead ${lead.id}:`,
                    error.message,
                );

                continue;
            }

            console.log(
                `🔍 FORMATTED RESPONSE FOR LEAD ${lead.id}`,
            );

            const results =
                Array.isArray(result?.data?.results)
                    ? result.data.results
                    : [];

            const seenPhones = new Set();

            for (const responseResult of results) {
                const responsePhone =
                    responseResult?.phone || null;

                if (
                    responsePhone &&
                    seenPhones.has(responsePhone)
                ) {
                    continue;
                }

                if (responsePhone) {
                    seenPhones.add(responsePhone);
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

            if (!results.length) {
                console.log(
                    "⚠️ No matched users or Twilio results.",
                );
            }

            /*
             * Do not use result.ok by itself.
             *
             * The API request can succeed while zero messages
             * were actually sent. At least one result must have
             * sent === true.
             */
            const successfulSends = results.filter(
                (responseResult) =>
                    responseResult?.sent === true,
            );

            const wasActuallySent =
                result?.ok === true &&
                successfulSends.length > 0;

            if (wasActuallySent) {
                await pool.query(
                    `
                        UPDATE familytreenow
                        SET lead_sent = TRUE
                        WHERE id = $1
                    `,
                    [lead.id],
                );

                console.log(
                    `✅ Marked lead ${lead.id} as sent ` +
                    `after ${successfulSends.length} ` +
                    `successful Twilio send(s)`,
                );
            } else {
                /*
                 * Explicitly keep it false in case another part of
                 * the workflow previously changed it.
                 */
                await pool.query(
                    `
                        UPDATE familytreenow
                        SET lead_sent = FALSE
                        WHERE id = $1
                    `,
                    [lead.id],
                );

                console.log(
                    `⚠️ Lead ${lead.id} did not produce a ` +
                    "successful Twilio send — keeping " +
                    "lead_sent = FALSE",
                );
            }
        }

        console.log(
            "🏁 Lead alert job complete.",
        );

        process.exit(0);
    } catch (error) {
        console.error(
            "💥 Fatal error:",
            error.message,
        );

        process.exit(1);
    }
})();