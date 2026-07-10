const { generateBulkPdfReport } = require('./bulkPdfGenerator');

describe('generateBulkPdfReport', () => {
  it('generates a PDF buffer for an empty list', async () => {
    const buffer = await generateBulkPdfReport([]);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // All PDFs start with %PDF-
    expect(buffer.toString('utf8', 0, 5)).toBe('%PDF-');
  });

  it('generates a PDF buffer for a list of records', async () => {
    const logs = [
      {
        created_at: Date.now(),
        customer_id: 'CUST123',
        recommended_product: 'NRE_FD',
        principal_amount: 10000,
        base_currency: 'USD',
        tenure_months: 12,
        fcnr_yield: 5.5,
        nre_yield: 6.0,
        recommendation_id: 'rec-123456789',
      },
      {
        created_at: Date.now() - 86400000,
        customer_id: 'CUST456',
        recommended_product: null,
        principal_amount: 5000,
        base_currency: 'GBP',
        tenure_months: 6,
        fcnr_yield: null,
        nre_yield: null,
        recommendation_id: 'rec-987654321',
      }
    ];

    const buffer = await generateBulkPdfReport(logs);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString('utf8', 0, 5)).toBe('%PDF-');
  });

  it('handles null or undefined gracefully', async () => {
    const buffer = await generateBulkPdfReport(null);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString('utf8', 0, 5)).toBe('%PDF-');
  });
});
