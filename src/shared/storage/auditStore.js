/**
 * Audit log store.
 */

const mysql = require('mysql2/promise');
const { logger } = require('../logger');

class AuditStore {
  /**
   * @param {object} opts
   * @param {object} [opts.mysql]
   * @param {number} [opts.recentCacheSize=200]
   */
  constructor(opts = {}) {
    this.driver = 'mysql';
    this.recentCacheSize = opts.recentCacheSize ?? 200;
    this.recent = [];
    this.ready = false;

    this.pool = mysql.createPool(opts.mysql);
    this._initMysql().catch((err) => logger.error('audit_mysql_init_failed', { error: err.message }));
  }

  async _initMysql() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        recommendation_id VARCHAR(255) PRIMARY KEY,
        customer_id VARCHAR(255) NOT NULL,
        employee_id VARCHAR(255),
        user_role VARCHAR(255),
        traceparent VARCHAR(255),
        input_json JSON NOT NULL,
        decision_json JSON NOT NULL,
        compliance_json JSON NOT NULL,
        advisory_json JSON NOT NULL,
        metadata_json JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_customer (customer_id),
        INDEX idx_audit_created (created_at),
        INDEX idx_audit_employee (employee_id),
        INDEX idx_audit_role (user_role)
      )
    `);
    this.ready = true;
    logger.info('audit_store_ready', { driver: 'mysql' });
    await this._warmCache();
  }

  async _warmCache() {
    try {
      const [rows] = await this.pool.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`, [this.recentCacheSize]);
      this.recent = rows.reverse();
    } catch (err) {
      logger.warn('audit_warm_cache_failed', { error: err.message });
    }
  }

  /**
   * Persist a single audit record.
   * @param {object} record
   */
  async insert(record) {
    const flat = {
      recommendation_id: record.recommendation_id,
      customer_id: record.customer_id,
      employee_id: record.employee_id || null,
      user_role: record.user_role || null,
      traceparent: record.traceparent || null,
      input_json: JSON.stringify(record.input || {}),
      decision_json: JSON.stringify(record.decision_trace || {}),
      compliance_json: JSON.stringify(record.compliance || {}),
      advisory_json: JSON.stringify(record.advisory || {}),
      metadata_json: JSON.stringify(record.metadata || {}),
    };

    const sql = `INSERT INTO audit_logs
      (recommendation_id, customer_id, employee_id, user_role, traceparent, input_json, decision_json, compliance_json, advisory_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.pool.query(sql, [
      flat.recommendation_id,
      flat.customer_id,
      flat.employee_id,
      flat.user_role,
      flat.traceparent,
      flat.input_json,
      flat.decision_json,
      flat.compliance_json,
      flat.advisory_json,
      flat.metadata_json,
    ]);

    // Update LRU recent cache only after durable persistence succeeds.
    this.recent.push(flat);
    if (this.recent.length > this.recentCacheSize) this.recent.shift();
  }

  /**
   * Query audit records with filters and pagination.
   * Returns: { total, page, limit, pages, logs }
   */
  async query({ page = 1, limit = 50, customer_id, product, from_date, to_date, employee_id, role }) {
    const filters = [];
    const params = [];
    if (customer_id) { filters.push('customer_id = ?'); params.push(customer_id); }
    if (employee_id) { filters.push('employee_id = ?'); params.push(employee_id); }
    if (role) { filters.push('user_role = ?'); params.push(role); }
    if (from_date) { filters.push('created_at >= ?'); params.push(from_date); }
    if (to_date) { filters.push('created_at <= ?'); params.push(to_date); }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const offset = (Math.max(1, page) - 1) * Math.min(200, Math.max(1, limit));
    const lm = Math.min(200, Math.max(1, limit));

    const [[{ total }]] = await this.pool.query(`SELECT COUNT(*) AS total FROM audit_logs ${where}`, params);

    const sql = `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const [rows] = await this.pool.query(sql, [...params, lm, offset]);

    const logs = rows.map((r) => this._rowToLog(r)).filter((l) => !product || l.recommended_product === product.toUpperCase());

    return { total: parseInt(total, 10), page: Math.max(1, page), limit: lm, pages: Math.ceil(total / lm), logs };
  }

  _rowToLog(row) {
    const decision = typeof row.decision_json === 'string' ? JSON.parse(row.decision_json) : row.decision_json;
    const advisory = typeof row.advisory_json === 'string' ? JSON.parse(row.advisory_json) : row.advisory_json;
    const meta = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json;
    const input = typeof row.input_json === 'string' ? JSON.parse(row.input_json) : row.input_json;
    return {
      recommendation_id: row.recommendation_id,
      customer_id: row.customer_id,
      employee_id: row.employee_id,
      user_role: row.user_role,
      traceparent: row.traceparent,
      created_at: row.created_at,
      computed_at: meta.computed_at || row.created_at,
      execution_time_ms: meta.execution_time_ms,
      recommended_product: advisory.recommended_product,
      fcnr_yield: decision.fcnr_effective_yield_pct,
      nre_yield: decision.nre_effective_yield_pct,
      fcnr_effective_yield_pct: decision.fcnr_effective_yield_pct,
      nre_effective_yield_pct: decision.nre_effective_yield_pct,
      alm_penalty_pct: decision.alm_penalty_pct,
      debt_to_asset_ratio: decision.debt_to_asset_ratio,
      principal_amount: input.principal_amount,
      base_currency: input.base_currency,
      tenure_months: input.tenure_months,
      risk_profile: input.risk_profile,
    };
  }

  async export({ customer_id, product, from_date, to_date, format = 'json' }) {
    const data = await this.query({ page: 1, limit: 200, customer_id, product, from_date, to_date });
    return data.logs;
  }

  async getRecent(limit = 50) {
    return this.recent.slice(-Math.max(1, limit));
  }

  async getById(id) {
    const [rows] = await this.pool.query(`SELECT * FROM audit_logs WHERE recommendation_id = ?`, [id]);
    if (!rows.length) return null;
    const row = rows[0];
    return {
      recommendation_id: row.recommendation_id,
      customer_id: row.customer_id,
      traceparent: row.traceparent,
      employee_id: row.employee_id,
      user_role: row.user_role,
      input: typeof row.input_json === 'string' ? JSON.parse(row.input_json) : row.input_json,
      decision_trace: typeof row.decision_json === 'string' ? JSON.parse(row.decision_json) : row.decision_json,
      compliance: typeof row.compliance_json === 'string' ? JSON.parse(row.compliance_json) : row.compliance_json,
      advisory: typeof row.advisory_json === 'string' ? JSON.parse(row.advisory_json) : row.advisory_json,
      metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
      created_at: row.created_at,
    };
  }

  async stats() {
    const [[row]] = await this.pool.query(`SELECT COUNT(*) AS total, COUNT(DISTINCT customer_id) AS unique_customers FROM audit_logs`);
    return { total: parseInt(row.total, 10), unique_customers: parseInt(row.unique_customers, 10), cache_size: this.recent.length };
  }

  async close() {
    return this.pool.end();
  }
}

module.exports = { AuditStore };
