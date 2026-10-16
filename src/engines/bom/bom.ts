import ExcelJS from 'exceljs';

/**
 * Bill of materials (port of the old `BOMExportScreen` logic): rows from the
 * selected parts, summary figures, and the XLSX / CSV exports with the same
 * columns and layout.
 */

export interface BomSourcePart {
  componentName?: string;
  manufacturer?: string;
  partNumber?: string;
  mouserPartNumber?: string;
  description?: string;
  quantity?: number;
  mountingType?: string;
  electricalSpecs?: Record<string, string>;
  pricingTiers?: Array<{ quantity: number; price: number }>;
  availability?: string;
  leadTime?: string;
  rohsStatus?: string;
  lifecycleStatus?: string;
  datasheetLink?: string;
  /** No distributor price yet: the price cells stay empty (Studio BOM). */
  unpriced?: boolean;
}

export interface BomRow {
  lineNumber: number;
  designator: string;
  manufacturer: string;
  manufacturerPartNumber: string;
  mouserPartNumber: string;
  description: string;
  quantity: number;
  packageType: string;
  unitPrice: number;
  extendedPrice: number;
  /** False when the part has no price (cells left empty, not 0.00). */
  priced: boolean;
  availability: string;
  leadTime: string;
  rohsStatus: string;
  lifecycleStatus: string;
  datasheetUrl: string;
}

export interface BomSummary {
  totalItems: number;
  totalQuantity: number;
  totalCost: number;
  uniqueManufacturers: number;
  inStockItems: number;
  stockPercentage: number;
}

/** Price columns name the currency (old layout: $). */
const SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' };
const symbolOf = (currency = 'USD') => SYMBOL[currency] ?? `${currency} `;
const headers = (currency?: string) =>
  HEADERS.map((h) => h.replace('($)', `(${symbolOf(currency).trim()})`));

const HEADERS = [
  'Line #',
  'Designator',
  'Manufacturer',
  'Manufacturer Part Number',
  'Mouser Part Number',
  'Description',
  'Quantity',
  'Package/Footprint',
  'Unit Price ($)',
  'Extended Price ($)',
  'Availability',
  'Lead Time',
  'RoHS Status',
  'Lifecycle Status',
  'Datasheet URL',
];
const WIDTHS = [8, 15, 20, 25, 20, 40, 10, 18, 12, 14, 15, 15, 15, 15, 40];

export function bomRows(parts: BomSourcePart[]): BomRow[] {
  return parts.map((part, index) => {
    // First tier = single-unit price (old behaviour).
    const tier = part.pricingTiers?.[0]?.price;
    const unitPrice =
      typeof tier === 'number' && Number.isFinite(tier) && tier >= 0 ? tier : 0;
    const qty = part.quantity;
    const quantity =
      typeof qty === 'number' && Number.isInteger(qty) && qty > 0 ? qty : 1;
    return {
      lineNumber: index + 1,
      designator: part.componentName || `COMP${index + 1}`,
      manufacturer: part.manufacturer || 'Unknown',
      manufacturerPartNumber: part.partNumber || 'N/A',
      mouserPartNumber: part.mouserPartNumber || 'N/A',
      description: part.description || 'No description available',
      quantity,
      packageType:
        part.mountingType || part.electricalSpecs?.['Package'] || 'N/A',
      unitPrice,
      extendedPrice: unitPrice * quantity,
      priced: !part.unpriced,
      availability: part.availability || 'Check Stock',
      leadTime: part.leadTime || 'Contact Supplier',
      rohsStatus: part.rohsStatus || 'RoHS Compliant',
      lifecycleStatus: part.lifecycleStatus || 'Active',
      datasheetUrl: part.datasheetLink || '',
    };
  });
}

export function bomSummary(rows: BomRow[]): BomSummary {
  const totalItems = rows.length;
  const inStockItems = rows.filter((r) => {
    const a = r.availability.toLowerCase();
    return a.includes('in stock') || a.includes('available');
  }).length;
  return {
    totalItems,
    totalQuantity: rows.reduce((s, r) => s + r.quantity, 0),
    totalCost: rows.reduce((s, r) => s + r.extendedPrice, 0),
    uniqueManufacturers: new Set(rows.map((r) => r.manufacturer)).size,
    inStockItems,
    stockPercentage:
      totalItems > 0 ? Math.round((inStockItems / totalItems) * 100) : 0,
  };
}

/** Cells starting with = + - @ (or tab/CR) would run as formulas in Excel. */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const cells = (r: BomRow): Array<string | number> => [
  r.lineNumber,
  r.designator,
  r.manufacturer,
  r.manufacturerPartNumber,
  r.mouserPartNumber,
  r.description,
  r.quantity,
  r.packageType,
  r.priced ? r.unitPrice.toFixed(2) : '',
  r.priced ? r.extendedPrice.toFixed(2) : '',
  r.availability,
  r.leadTime,
  r.rohsStatus,
  r.lifecycleStatus,
  r.datasheetUrl,
];

const safe = (v: string | number): string | number =>
  typeof v === 'string' ? neutralizeFormula(v) : v;

export function bomFilename(
  projectName: string,
  ext: 'xlsx' | 'csv',
  now = new Date(),
): string {
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const name =
    projectName.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '') ||
    'Power_Supply_Design';
  return `BOM_${name}_${date}.${ext}`;
}

export async function bomXlsx(
  rows: BomRow[],
  projectName: string,
  now = new Date(),
  currency?: string,
): Promise<Buffer> {
  const summary = bomSummary(rows);
  const symbol = symbolOf(currency);
  const workbook = new ExcelJS.Workbook();
  workbook.created = now;
  const sheet = workbook.addWorksheet('Bill of Materials');
  sheet.addRow([neutralizeFormula(`Bill of Materials - ${projectName}`)]);
  sheet.addRow([
    `Generated: ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`,
  ]);
  sheet.addRow([]);
  sheet.addRow([
    `Total Components: ${summary.totalItems}`,
    `Total Quantity: ${summary.totalQuantity}`,
    `Total Cost: ${symbol}${summary.totalCost.toFixed(2)}`,
    `Manufacturers: ${summary.uniqueManufacturers}`,
  ]);
  sheet.addRow([]);
  sheet.addRow(headers(currency)).font = { bold: true };
  for (const r of rows) sheet.addRow(cells(r).map(safe));
  sheet.addRow([]);
  sheet.addRow([
    'TOTALS',
    '',
    '',
    '',
    '',
    '',
    summary.totalQuantity,
    '',
    '',
    `${symbol}${summary.totalCost.toFixed(2)}`,
  ]);
  WIDTHS.forEach((width, i) => {
    sheet.getColumn(i + 1).width = width;
  });
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

export function bomCsv(rows: BomRow[], currency?: string): Buffer {
  const quote = (v: string | number) =>
    typeof v === 'number'
      ? String(v)
      : `"${neutralizeFormula(v).replace(/"/g, '""')}"`;
  const lines = [
    headers(currency).join(','),
    ...rows.map((r) =>
      cells(r)
        .map((v, i) => (i === 8 || i === 9 ? String(v) : quote(v)))
        .join(','),
    ),
  ];
  // BOM prefix so Excel opens it as UTF-8.
  return Buffer.from(`\uFEFF${lines.join('\n')}`, 'utf8');
}
