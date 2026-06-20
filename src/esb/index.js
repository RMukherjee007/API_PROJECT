const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8081;

// Initialize SQLite CBS Database
const dbPath = path.resolve(__dirname, 'cbs_database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[ESB] Database connection error:', err.message);
    } else {
        console.log('[ESB] Connected to SQLite mock CBS database.');
    }
});

// Setup and Seed Database
db.serialize(() => {
    // Assets table
    db.run(`CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT,
        market_value REAL,
        currency TEXT,
        asset_type TEXT,
        source TEXT,
        valuation_date TEXT
    )`);

    // Liabilities table
    db.run(`CREATE TABLE IF NOT EXISTS liabilities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT,
        outstanding_principal REAL,
        currency TEXT,
        liability_type TEXT,
        source TEXT,
        valuation_date TEXT
    )`);

    // Check if seeded
    db.get("SELECT COUNT(*) AS count FROM assets", (err, row) => {
        if (row && row.count === 0) {
            console.log('[ESB] Seeding mock customers...');
            
            // CUST123: Moderate Leverage
            db.run(`INSERT INTO assets (customer_id, market_value, currency, asset_type, source, valuation_date) VALUES ('CUST123', 50000.00, 'USD', 'FIXED_DEPOSIT', 'CBS_CORE', '2026-06-01')`);
            db.run(`INSERT INTO assets (customer_id, market_value, currency, asset_type, source, valuation_date) VALUES ('CUST123', 10000.00, 'GBP', 'SAVINGS_ACCOUNT', 'CBS_CORE', '2026-06-10')`);
            db.run(`INSERT INTO liabilities (customer_id, outstanding_principal, currency, liability_type, source, valuation_date) VALUES ('CUST123', 2000000.00, 'INR', 'HOME_LOAN', 'LOS', '2026-06-15')`);
            
            // CUST_RICH: No Leverage (Massive Assets)
            db.run(`INSERT INTO assets (customer_id, market_value, currency, asset_type, source, valuation_date) VALUES ('CUST_RICH', 100000.00, 'USD', 'FCNR_ACCOUNT', 'CBS_CORE', '2026-06-05')`);
            db.run(`INSERT INTO assets (customer_id, market_value, currency, asset_type, source, valuation_date) VALUES ('CUST_RICH', 5000000.00, 'INR', 'SAVINGS_ACCOUNT', 'CBS_CORE', '2026-06-05')`);

            // CUST_LEVERAGED: Highly Leveraged (Massive Loans, few deposits)
            db.run(`INSERT INTO assets (customer_id, market_value, currency, asset_type, source, valuation_date) VALUES ('CUST_LEVERAGED', 2000.00, 'USD', 'SAVINGS_ACCOUNT', 'CBS_CORE', '2026-06-05')`);
            db.run(`INSERT INTO liabilities (customer_id, outstanding_principal, currency, liability_type, source, valuation_date) VALUES ('CUST_LEVERAGED', 10000000.00, 'INR', 'BUSINESS_LOAN', 'LOS', '2026-06-15')`);
            db.run(`INSERT INTO liabilities (customer_id, outstanding_principal, currency, liability_type, source, valuation_date) VALUES ('CUST_LEVERAGED', 50000.00, 'USD', 'CREDIT_CARD', 'LOS', '2026-06-15')`);
        }
    });
});

app.get('/portfolio/:customer_id', (req, res) => {
    const { customer_id } = req.params;
    console.log(`[ESB] Received request to fetch portfolio for: ${customer_id}`);

    if (customer_id === "FAIL_CBS") {
        console.error(`[ESB] Circuit Breaker OPEN for CBS. Fast-failing.`);
        return res.status(503).json({ error: "Legacy CBS is unreachable." });
    }

    // Simulate latency of legacy system
    setTimeout(() => {
        db.all("SELECT * FROM assets WHERE customer_id = ?", [customer_id], (err, assets) => {
            if (err) return res.status(500).json({ error: err.message });
            
            db.all("SELECT * FROM liabilities WHERE customer_id = ?", [customer_id], (err, liabilities) => {
                if (err) return res.status(500).json({ error: err.message });

                const portfolio = {
                    assets: assets.map(a => ({ market_value: Number(a.market_value).toFixed(2), currency: a.currency, asset_type: a.asset_type, source: a.source, valuation_date: a.valuation_date })),
                    liabilities: liabilities.map(l => ({ outstanding_principal: Number(l.outstanding_principal).toFixed(2), currency: l.currency, liability_type: l.liability_type, source: l.source, valuation_date: l.valuation_date }))
                };

                console.log(`[ESB] Successfully translated data for ${customer_id}`);
                res.json({
                    source: "ESB_FETCH",
                    positions_injected: {
                        asset_count: portfolio.assets.length,
                        liability_count: portfolio.liabilities.length
                    },
                    assets: portfolio.assets,
                    liabilities: portfolio.liabilities
                });
            });
        });
    }, 300); // 300ms mock delay
});

app.listen(PORT, () => {
    console.log(`[ESB] Lightweight ESB Layer listening on port ${PORT}`);
});
