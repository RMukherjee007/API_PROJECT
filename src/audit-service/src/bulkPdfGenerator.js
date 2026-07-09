/**
 * Bulk PDF report generator for audit service.
 * Uses PDFKit to generate a tabular summary of multiple recommendations.
 */

const PDFDocument = require('pdfkit');

function generateBulkPdfReport(logs) {
  return new Promise((resolve, reject) => {
    // Defensively handle cases where logs might be null or undefined.
    const safeLogs = Array.isArray(logs) ? logs : [];

    try {
      const doc = new PDFDocument({ margin: 30, size: 'A4', info: { Title: 'NRI Yield Recommendations Summary', Author: 'CSB Treasury Tech' } });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const primary = '#005a9c';
      const text = '#333333';
      const muted = '#666666';

      // Header
      doc.fontSize(16).font('Helvetica-Bold').fillColor(primary).text('NRI Yield Advisory — Recommendations Summary', { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica').fillColor(muted).text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(10).text(`Total Records: ${safeLogs.length}`, { align: 'center' });
      doc.moveDown(1);

      // Table Headers
      const startX = 30;
      let y = doc.y;

      const drawRow = (y, cols, isHeader = false) => {
        doc.fontSize(isHeader ? 9 : 8).font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fillColor(isHeader ? '#000000' : text);
        doc.text(cols[0], startX, y, { width: 90 });           // Date
        doc.text(cols[1], startX + 90, y, { width: 60 });      // Cust ID
        doc.text(cols[2], startX + 150, y, { width: 60 });     // Product
        doc.text(cols[3], startX + 210, y, { width: 80 });     // Amount
        doc.text(cols[4], startX + 290, y, { width: 40 });     // Ten.
        doc.text(cols[5], startX + 330, y, { width: 50 });     // FCNR
        doc.text(cols[6], startX + 380, y, { width: 50 });     // NRE
        doc.text(cols[7], startX + 430, y, { width: 100 });    // Rec ID
      };

      // Draw Header
      drawRow(y, ['Date', 'Customer', 'Rec.', 'Amount', 'Ten.', 'FCNR %', 'NRE %', 'ID'], true);
      y += 15;
      doc.moveTo(startX, y).lineTo(565, y).strokeColor('#cccccc').stroke();
      y += 5;

      // Draw Rows
      for (const log of safeLogs) {
        if (y > 750) {
          doc.addPage();
          y = 30;
          drawRow(y, ['Date', 'Customer', 'Rec.', 'Amount', 'Ten.', 'FCNR %', 'NRE %', 'ID'], true);
          y += 15;
          doc.moveTo(startX, y).lineTo(565, y).strokeColor('#cccccc').stroke();
          y += 5;
        }

        const dateStr = new Date(log.created_at).toISOString().split('T')[0];
        const amtStr = `${log.principal_amount} ${log.base_currency}`;

        drawRow(y, [
          dateStr,
          log.customer_id,
          log.recommended_product || 'N/A',
          amtStr,
          String(log.tenure_months),
          log.fcnr_yield ? String(log.fcnr_yield) : '-',
          log.nre_yield ? String(log.nre_yield) : '-',
          log.recommendation_id.substring(0, 8) + '...'
        ]);

        y += 15;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateBulkPdfReport };
