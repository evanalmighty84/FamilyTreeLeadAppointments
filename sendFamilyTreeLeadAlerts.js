// sendFamilyTreeLeadAlerts.js
require('dotenv').config();
const pool = require('./db/db.js');
const { postLeadAlert } = require('./leadAlertClient');

const BASE_URL =
    process.env.NODE_ENV === "production"
        ? "https://crm-function-app-5d4de511071d.herokuapp.com/server/crm_function"
        : "http://localhost:5000/server/crm_function";

(async () => {
    console.log('🚀 Starting FamilyTreeNow Lead Alert job');

    console.log("🔧 Using LEAD ALERT URL:", process.env.LEAD_ALERT_URL);

    const PROD_ALERT_URL =
        process.env.LEAD_ALERT_URL ||
        `${BASE_URL}/api/smsqueue/alert-lead`;

    try {
        // Confirm DB connection works
        await pool.query('SELECT NOW()');
        console.log('✅ Successfully connected to PostgreSQL database');

        // Pull only leads not yet sent
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
                physical_address
            FROM familytreenow
            WHERE
                (lead_sent IS FALSE OR lead_sent IS NULL)
    AND phone IS NOT NULL
    AND (scraped_at >= NOW() - INTERVAL '1 day')
            ORDER BY id ASC;

        `);

        if (!leads.length) {
            console.log('✅ No new FamilyTreeNow leads to send.');
            process.exit(0);
        }

        console.log(`📋 Found ${leads.length} unsent lead(s)`);

        for (const lead of leads) {
            console.log(`📤 Sending alert for lead ${lead.id}: ${lead.name} (${lead.phone})`);

            const result = await postLeadAlert(lead);

            console.log("🔍 FULL RAW API RESPONSE FOR LEAD", lead.id);
            console.log(JSON.stringify(result, null, 2));

            // ⭐ If ANY user was matched + message was sent, then mark as sent
            if (result && result.ok) {
                await pool.query(
                    `UPDATE familytreenow SET lead_sent = TRUE WHERE id = $1`,
                    [lead.id]
                );
                console.log(`✅ Marked lead ${lead.id} as sent`);
            } else {
                console.log(`⚠️ Lead ${lead.id} did NOT send — keeping lead_sent = FALSE`);
            }
        }


        console.log('🏁 Lead alert job complete.');
        process.exit(0);
    } catch (err) {
        console.error('💥 Fatal error:', err.message);
        process.exit(1);
    }
})();
