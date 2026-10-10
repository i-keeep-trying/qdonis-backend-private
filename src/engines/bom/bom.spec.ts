import ExcelJS from 'exceljs';

import {
  bomCsv,
  bomFilename,
  bomRows,
  bomSummary,
  bomXlsx,
  neutralizeFormula,
} from './bom';

describe('bom', () => {
  const parts = [
    {
      componentName: 'Q1',
      manufacturer: 'A',
      pricingTiers: [{ quantity: 1, price: 2 }],
      quantity: 3,
      availability: '10 In Stock',
    },
    { description: '=cmd|"/c calc"!A1', quantity: -4 },
  ];

  it('builds rows with the old defaults and totals', () => {
    const rows = bomRows(parts);
    expect(rows[1]).toMatchObject({
      designator: 'COMP2',
      manufacturer: 'Unknown',
      quantity: 1,
      unitPrice: 0,
    });
    expect(bomSummary(rows)).toEqual({
      totalItems: 2,
      totalQuantity: 4,
      totalCost: 6,
      uniqueManufacturers: 2,
      inStockItems: 1,
      stockPercentage: 50,
    });
  });

  it('neutralises spreadsheet formulas in exports', async () => {
    expect(neutralizeFormula('=1+1')).toBe("'=1+1");
    expect(neutralizeFormula('plain')).toBe('plain');
    const csv = bomCsv(bomRows(parts)).toString('utf8');
    expect(csv).toContain(`"'=cmd|""/c calc""!A1"`);

    const workbook = new ExcelJS.Workbook();
    const file = await bomXlsx(bomRows(parts), 'Test');
    await workbook.xlsx.load(file as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('Bill of Materials')!;
    expect(sheet.getRow(8).getCell(6).value).toBe('\'=cmd|"/c calc"!A1');
  });

  it('builds safe file names', () => {
    expect(
      bomFilename('My Proj/../x', 'csv', new Date('2026-01-05T00:00:00Z')),
    ).toBe('BOM_My_Proj..x_20260105.csv');
  });
});
