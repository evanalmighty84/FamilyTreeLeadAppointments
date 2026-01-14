// 5starpaintingenrichment.js
require("dotenv").config();
const pool = require("./db/db");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
    console.log("🎨 Fetching recent painter-related posts...");

    try {
        // 1️⃣ Ensure destination table exists (now includes city + lead_type)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS painting_nextdoor_messages (
                                                                      id SERIAL PRIMARY KEY,
                                                                      state TEXT,
                                                                      city TEXT,
                                                                      description TEXT,
                                                                      timestamp TIMESTAMP,
                                                                      author TEXT,
                                                                      location TEXT,
                                                                      post_url TEXT,
                                                                      lead_type TEXT
            );
        `);
        console.log("✅ Table painting_nextdoor_messages ready.");

        // 2️⃣ Fetch painter-type messages from the past 2 days
        const { rows } = await pool.query(`
            SELECT state, city, description, timestamp, author, location, post_url, lead_type
            FROM nextdoor_messages
            WHERE lead_type ILIKE '%painter%'
              AND timestamp >= NOW() - INTERVAL '3 days'
            ORDER BY timestamp DESC;
        `);

        if (!rows.length) {
            console.log("✅ No painter posts found in the last 2 days.");
            process.exit(0);
        }

        console.log(`🎯 Found ${rows.length} painter posts — sending to GPT-5 for classification...`);

        // 3️⃣ Build GPT prompt
        const descriptions = rows
            .map((r, i) => `${i + 1}. ${r.author} (${r.state}): ${r.description}`)
            .join("\n");

        const prompt = `
You’re classifying neighborhood posts to identify *painting service requests*.

Label each post:
- ✅ if the author is seeking painting help
- ⚠️ if tangentially painting-related (drywall, handyman involving paint, refinishing)
- ❌ if offering painting services or unrelated.

Return JSON only:
[
  {"label":"✅|⚠️|❌","author":"...","state":"...","description":"(short summary)","reason":"..."}
]

Posts:
${descriptions}
`;

        // 4️⃣ Send to GPT-5
        const gpt = await openai.chat.completions.create({
            model: "gpt-5",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
        });

        const rawOutput = gpt.choices?.[0]?.message?.content?.trim();
        if (!rawOutput) throw new Error("No response from GPT-5");

        console.log("🔍 RAW GPT-5 OUTPUT START ------------------------");
        console.log(rawOutput);
        console.log("🔍 RAW GPT-5 OUTPUT END --------------------------");

        let parsed;
        try {
            parsed = JSON.parse(rawOutput);
            console.log("✅ Parsed JSON successfully.");
        } catch (e) {
            console.error("❌ JSON.parse failed:", e.message);
            console.log("💬 Raw Output (first 500 chars):", rawOutput.slice(0, 500));
            throw e;
        }

        // Normalize the parsed data to always be an array
        if (!Array.isArray(parsed)) {
            if (parsed.results && Array.isArray(parsed.results)) parsed = parsed.results;
            else if (parsed.data && Array.isArray(parsed.data)) parsed = parsed.data;
            else parsed = [parsed];
        }

        console.log("✅ Sample parsed item:", parsed[0]);

        console.log("🧠 GPT-5 Classification Results:");
        console.table(
            parsed.map((p) => ({
                label: p.label,
                author: p.author,
                state: p.state,
                reason: p.reason,
            }))
        );

        // 5️⃣ Insert all ✅ and ⚠️ into painting_nextdoor_messages
        let inserted = 0;
        for (let i = 0; i < parsed.length; i++) {
            const g = parsed[i];
            const dbLead = rows[i];

            if (g.label === "✅" || g.label === "⚠️") {
                await pool.query(
                    `
                        INSERT INTO painting_nextdoor_messages
                        (state, city, description, timestamp, author, location, post_url, lead_type)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            ON CONFLICT DO NOTHING;
                    `,
                    [
                        dbLead.state,
                        dbLead.city,
                        dbLead.description,
                        dbLead.timestamp,
                        dbLead.author,
                        dbLead.location,
                        dbLead.post_url,
                        dbLead.lead_type || 'painting', // fallback
                    ]
                );
                inserted++;
            }
        }

        console.log(`✅ Inserted ${inserted} painter-related posts into painting_nextdoor_messages.`);
        process.exit(0);
    } catch (err) {
        console.error("❌ 5starpaintingenrichment error:", err);
        process.exit(1);
    }
})();
