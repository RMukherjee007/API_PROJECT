/**
 * PDF report generator.
 *
 * Uses PDFKit. Renders:
 *  - Header with bank logo placeholder + report generation timestamp
 *  - Customer block
 *  - Recommendation block (with rationale)
 *  - Yield comparison table (FCNR vs NRE)
 *  - Decision trace (rates used, ALM penalty, inflation)
 *  - Portfolio block (assets + liabilities in INR)
 *  - Compliance + warnings
 *  - Override block (if override was used, with reason + approver)
 *  - Signature block (HMAC of decision-trace JSON)
 *  - Footer (disclaimer + page numbers)
 */

const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const config = require('../../shared/config');

function generatePdfReport(result) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: 'NRI Yield Advisory Report', Author: 'CSB Treasury Tech', Subject: 'FCNR vs NRE Recommendation' } });
      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const green = '#388e3c';
      const dark = '#1a1a1a';
      const muted = '#757575';
      const warn = '#b45309';

      // Header
      doc.fontSize(24).font('Helvetica-Bold').fillColor(green).text('NRI Yield Advisory', { align: 'center' });
      doc.fontSize(9).font('Helvetica').fillColor(muted).text(`Report generated: ${new Date().toISOString()}`, { align: 'center' });
      doc.text(`Service: ${config.serviceName} | Env: ${config.env}`, { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e0e0e0').stroke();
      doc.moveDown(1);

      // Recommendation
      const product = result.advisory.recommended_product;
      doc.fontSize(16).font('Helvetica-Bold').fillColor(dark).text('Recommendation', { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(30).font('Helvetica-Bold').fillColor(green).text(product, { align: 'center' });
      doc.moveDown(0.4);
      const rationale = product === 'FCNR'
        ? 'Foreign-currency deposit provides superior yield given current spot/forward curve and your portfolio composition.'
        : product === 'NRE'
          ? 'INR-denominated deposit provides superior FX-adjusted yield given the current forward premium.'
          : 'Yields are within threshold; either deposit is acceptable based on liquidity preference.';
      doc.fontSize(10).font('Helvetica').fillColor(muted).text(rationale, { align: 'center' });
      doc.moveDown(1);

      // Customer Info
      doc.fontSize(13).font('Helvetica-Bold').fillColor(dark).text('Customer Details');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor(dark);
      const meta = result.metadata;
      doc.text(`Customer ID: ${meta.customer_id}`);
      doc.text(`Risk Profile: ${meta.customer_risk_profile || '-'}`);
      doc.text(`Principal: ${meta.principal_amount} ${meta.base_currency}`);
      doc.text(`Tenure: ${meta.tenure_months} months`);
      doc.text(`Value Date: ${meta.value_date}`);
      doc.text(`Recommendation ID: ${meta.recommendation_id}`);
      doc.text(`Computed At: ${meta.computed_at}`);
      doc.text(`Execution Time: ${meta.execution_time_ms}ms`);
      doc.text(`Policy Version: ${meta.policy_version}`);
      doc.text(`Rates As Of: ${meta.rates_as_of}`);
      doc.moveDown(1);

      // Yield Comparison Table
      doc.fontSize(13).font('Helvetica-Bold').fillColor(dark).text('Yield Comparison');
      doc.moveDown(0.3);

      const trace = result.decision_trace;
      const tableTop = doc.y;
      const col1 = 50, col2 = 200, col3 = 350;
      const rowH = 20;

      doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff');
      doc.rect(col1, tableTop, 150, rowH).fill(green);
      doc.rect(col2, tableTop, 150, rowH).fill(green);
      doc.rect(col3, tableTop, 150, rowH).fill(green);
      doc.fillColor('#ffffff').text('Metric', col1 + 5, tableTop + 5);
      doc.text('FCNR', col2 + 5, tableTop + 5);
      doc.text('NRE', col3 + 5, tableTop + 5);

      const rows = [
        ['Nominal Yield', trace.fcnr_effective_yield_pct + '%', trace.nre_effective_yield_pct + '%'],
        ['ALM Penalty', trace.alm_penalty_pct + '%', '0.00% (Not Applied)'],
      ];
      if (trace.calculation_method === 'REAL_PPP_ADJUSTED') {
        rows.push(['Real Yield (Fisher/PPP)', trace.fcnr_real_yield_pct + '%', trace.nre_real_yield_pct + '%']);
      }
      rows.push(['Spot Rate', trace.product_spot_rate_used || 'N/A', 'N/A']);
      rows.push(['Forward Rate', trace.product_forward_rate_used || 'N/A', 'N/A']);

      let yPos = tableTop + rowH;
      for (const [i, row] of rows.entries()) {
        if (i % 2 === 0) doc.rect(col1, yPos, 450, rowH).fill('#f5f5f5');
        doc.fillColor(dark).font('Helvetica').fontSize(9);
        doc.text(row[0], col1 + 5, yPos + 5);
        doc.text(row[1], col2 + 5, yPos + 5);
        doc.text(row[2], col3 + 5, yPos + 5);
        yPos += rowH;
      }
      doc.y = yPos + 10;
      doc.moveDown(1);

      // ALM Details
      doc.fontSize(13).font('Helvetica-Bold').fillColor(dark).text('Asset-Liability Management');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor(dark);
      doc.text(`Total Assets (INR): ${trace.total_assets_inr}`);
      doc.text(`Total Liabilities (INR): ${trace.total_liabilities_inr}`);
      doc.text(`Weighted Bank Assets (INR): ${trace.weighted_bank_assets_inr}`);
      doc.text(`Debt-to-Asset Ratio: ${trace.debt_to_asset_ratio}`);
      doc.text(`ALM Penalty Applied: ${trace.alm_penalty_applied ? 'Yes' : 'No'}`);
      doc.text(`ALM Penalty (Pct): ${trace.alm_penalty_pct}%`);
      doc.text(`ALM Penalty (Amount INR): ${trace.alm_penalty_amount}`);
      doc.moveDown(1);

      // Compliance
      doc.fontSize(13).font('Helvetica-Bold').fillColor(dark).text('Compliance & Tax');
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica').fillColor(muted);
      doc.text(result.compliance.tax_treatment);
      doc.moveDown(0.4);
      doc.text(result.compliance.premature_withdrawal_note);
      doc.moveDown(0.5);

      if (result.advisory.compliance_warnings.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').fillColor(warn).text('Warnings & Notices');
        doc.moveDown(0.3);
        doc.fontSize(9).font('Helvetica').fillColor(warn);
        for (const w of result.advisory.compliance_warnings) {
          doc.text(`• ${w}`);
          doc.moveDown(0.2);
        }
      }

      // Override block (if any)
      if (meta.is_override_computation) {
        doc.moveDown(0.5);
        doc.fontSize(12).font('Helvetica-Bold').fillColor(warn).text('Override Information');
        doc.moveDown(0.2);
        doc.fontSize(9).font('Helvetica').fillColor(warn);
        doc.text('This recommendation was computed using RM-supplied rate overrides and is INDICATIVE.');
        if (meta.override_reason) doc.text(`Reason: ${meta.override_reason}`);
        if (meta.approved_by) doc.text(`Approved By: ${meta.approved_by}`);
        if (meta.approval_timestamp) doc.text(`Approval Time: ${meta.approval_timestamp}`);
        if (meta.override_ticket_id) doc.text(`Ticket: ${meta.override_ticket_id}`);
      }

      // Signature Block - HMAC of the decision trace ensures report integrity
      const decisionTraceString = JSON.stringify(result.decision_trace);
      const signature = crypto
        .createHmac('sha256', config.security.hmacSharedSecret)
        .update(decisionTraceString)
        .digest('hex');

      doc.moveDown(1);
      doc.fontSize(8).font('Helvetica-Oblique').fillColor(muted).text('Report Integrity Signature:', { continued: true }).font('Courier').text(` ${signature}`, { lineBreak: false });

      // Footer
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e0e0e0').stroke();
      doc.moveDown(0.5);
      doc.fontSize(8).font('Helvetica').fillColor(muted)
        .text('This report is for informational purposes only. Final investment decisions should be made in consultation with a qualified financial advisor.', { align: 'center' });


      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generatePdfReport };
