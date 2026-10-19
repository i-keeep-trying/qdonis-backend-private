// Mouser search strategy (ported from the old frontend services/mouserService.ts):
// keyword generation, name parsing, spec normalisation, weighted strategies,
// ranking/deduplication and the part -> ComponentOption mapping. No I/O here.
import type { ComponentOption } from '../engines/reliability/reliability.types';
export interface MouserSearchRequest {
  SearchByKeywordRequest: {
    keyword: string;
    records: number;
    startingRecord: number;
    searchOptions?: string;
    searchWithYourSignUpLanguage?: string;
  };
}

export interface MouserPartSearchRequest {
  SearchByPartRequest: {
    mouserPartNumber: string;
    partSearchOptions?: string;
  };
}

export interface MouserPriceBreak {
  Quantity: number;
  Price: string;
  Currency: string;
}

export interface MouserPart {
  Availability: string;
  DataSheetUrl: string;
  Description: string;
  FactoryStock: string;
  ImagePath: string;
  Category: string;
  LeadTime: string;
  LifecycleStatus: string;
  Manufacturer: string;
  ManufacturerPartNumber: string;
  Min: string;
  Mult: string;
  MouserPartNumber: string;
  ProductAttributes: Array<{
    AttributeName: string;
    AttributeValue: string;
  }>;
  PriceBreaks: MouserPriceBreak[];
  ProductDetailUrl: string;
  Reeling: boolean;
  ROHSStatus: string;
  SuggestedReplacement: string;
  MultiSimBlue: number;
  UnitWeightKg: number;
  PrimaryVideo: string;
  PDFUrl: string;
  // Allow for any additional fields that Mouser might return
  [key: string]: unknown;
}

export interface MouserSearchResponse {
  SearchResults: {
    NumberOfResult: number;
    Parts: MouserPart[];
  };
  Errors: Array<{
    Id: number;
    Code: string;
    Message: string;
    ResourceKey: string;
    ResourceFormatString: string;
    ResourceFormatString2: string;
    PropertyName: string;
  }>;
}

export interface MouserSearchParams {
  keyword: string;
  records?: number;
  startingRecord?: number;
  searchOptions?: string;
}

export interface ComponentSpecifications {
  type: string;
  voltageRating?: string;
  currentRating?: string;
  powerRating?: string;
  inductance?: string;
  capacitance?: string;
  resistance?: string;
  packageType?: string;
  mountingType?: string;
  operatingTempRange?: string;
  efficiency?: string;
  tolerance?: string;
  saturationCurrent?: string;
  coreType?: string;
  applicationNotes?: string;
  designConstraints?: string[];
  partNumber?: string; // Optional: Specific part number for more targeted searches
}

/**
 * Generate intelligent search keywords based on component specifications
 */
export const generateSearchKeywords = (
  specs: ComponentSpecifications,
): string[] => {
  const keywords: string[] = [];

  // Primary component type
  keywords.push(specs.type);

  // Add specific electrical parameters
  if (specs.inductance) {
    const inductanceValue = specs.inductance.replace(/[^\d.]/g, '');
    const inductanceUnit = specs.inductance.replace(/[\d.]/g, '').trim();
    keywords.push(`${inductanceValue}${inductanceUnit} inductor`);
  }

  if (specs.capacitance) {
    const capacitanceValue = specs.capacitance.replace(/[^\d.]/g, '');
    const capacitanceUnit = specs.capacitance.replace(/[\d.]/g, '').trim();
    keywords.push(`${capacitanceValue}${capacitanceUnit} capacitor`);
  }

  if (specs.voltageRating) {
    keywords.push(`${specs.voltageRating} voltage rating`);
  }

  if (specs.currentRating) {
    keywords.push(`${specs.currentRating} current rating`);
  }

  if (specs.powerRating) {
    keywords.push(`${specs.powerRating} power`);
  }

  // Add package/mounting preferences
  if (specs.packageType) {
    keywords.push(specs.packageType);
  }

  if (specs.mountingType) {
    keywords.push(specs.mountingType);
  }

  // Add core type for magnetic components
  if (specs.coreType) {
    keywords.push(`${specs.coreType} core`);
  }

  return keywords;
};

/**
 * Fetch full part details using Mouser part number
 */
export const hasPackageAttribute = (
  attributes: Array<{ AttributeName: string; AttributeValue: string }>,
): boolean => {
  return attributes.some(
    (attr) =>
      attr.AttributeName.toLowerCase().includes('package') ||
      attr.AttributeName.toLowerCase().includes('case') ||
      attr.AttributeName.toLowerCase().includes('pkg'),
  );
};

/**
 * Normalize units and text for better Mouser keyword matching
 * - Replace micro sign (µ/μ) with 'u'
 * - Normalize ohm symbol to 'Ohm'
 * - Ensure a space between number and unit (e.g., 47uH -> 47 uH)
 */
export const normalizeUnitText = (raw?: string): string => {
  if (!raw) return '';
  let s = raw.trim();
  s = s.replace(/[µμ]/g, 'u');
  s = s.replace(/Ω/g, 'Ohm');
  s = s.replace(/°C/g, 'C');
  // Add space between number and unit when letters immediately follow digits
  s = s.replace(
    /(\d+(?:\.\d+)?)(\s*[a-zA-Z]+)/g,
    (_match: string, num: string, unit: string) => `${num} ${unit.trim()}`,
  );
  // Collapse multiple spaces
  s = s.replace(/\s{2,}/g, ' ');
  return s;
};

/**
 * Extract descriptors from bracket text for type/channel/material cues
 */
export const extractDescriptorsFromBracket = (bracketText: string) => {
  const lower = bracketText.toLowerCase();
  const tokens = {
    isNChannel: /\bn[-\s]?channel\b|\bnmos\b/.test(lower),
    isPChannel: /\bp[-\s]?channel\b|\bpmos\b/.test(lower),
    isSchottky: /schottky/.test(lower),
    isCeramic: /ceramic|mlcc/.test(lower),
    isElectrolytic: /electrolytic/.test(lower),
    isFilm: /film/.test(lower),
    hasSMD: /\bsmd\b|surface mount/.test(lower),
    hasTHT: /through hole|\btht\b|radial|axial/.test(lower),
    packageCode:
      (lower.match(
        /\b(0603|0805|1206|1210|1812|sot-?23|soic|sma|smb|sot-223|to-220|to-247)\b/i,
      ) || [])[0] || '',
  };
  return tokens;
};

/**
 * Interface for parsed component name information
 */
export interface ParsedComponentName {
  originalName: string;
  partNumber: string | null;
  bracketText: string;
  trailingType: string;
  descriptors: {
    isNChannel: boolean;
    isPChannel: boolean;
    isSchottky: boolean;
    isCeramic: boolean;
    isElectrolytic: boolean;
    isFilm: boolean;
    hasSMD: boolean;
    hasTHT: boolean;
    packageCode: string;
  };
}

/**
 * Parse component name to extract part numbers, bracket text, trailing types, and descriptors
 * Examples:
 *   "M1 (IRF540N) mosfet" -> partNumber: "IRF540N", bracketText: "IRF540N", trailingType: "mosfet"
 *   "L1 (47uH) inductor" -> partNumber: null, bracketText: "47uH", trailingType: "inductor"
 *   "Q1 (2N7002 N-channel) mosfet" -> partNumber: "2N7002", bracketText: "2N7002 N-channel", trailingType: "mosfet"
 */
export const parseComponentName = (
  componentName: string,
): ParsedComponentName => {
  // Extract text within parentheses
  const bracketMatch = componentName.match(/\(([^)]+)\)/);
  const bracketText = bracketMatch ? bracketMatch[1].trim() : '';

  // Extract trailing type after closing parenthesis
  const trailingTypeMatch = componentName.match(/\)\s*([A-Za-z_\- ]+)$/);
  const trailingType = trailingTypeMatch
    ? trailingTypeMatch[1].trim().toLowerCase()
    : '';

  // Parse first word in brackets as potential part number
  // Part numbers typically start with alphanumeric characters and may contain hyphens
  let partNumber: string | null = null;
  if (bracketText) {
    const firstWord = bracketText.split(/\s+/)[0];
    // Check if first word looks like a part number (contains letters and numbers, not just a value like "47uH")
    if (
      /^[A-Za-z0-9][\w-]*$/.test(firstWord) &&
      /[A-Za-z]/.test(firstWord) &&
      /\d/.test(firstWord)
    ) {
      partNumber = firstWord;
    }
  }

  // Extract component descriptors from bracket text
  const descriptors = extractDescriptorsFromBracket(bracketText);

  return {
    originalName: componentName,
    partNumber,
    bracketText,
    trailingType,
    descriptors,
  };
};

/**
 * Interface for normalized specifications
 */
export interface NormalizedSpecifications {
  voltage: string;
  current: string;
  power: string;
  inductance: string;
  capacitance: string;
  resistance: string;
  tolerance: string;
  saturationCurrent: string;
  packageOrMount: string;
}

/**
 * Normalize specifications by applying unit text normalization and filtering out zero/empty values
 * This ensures consistent formatting for Mouser searches
 */
export const normalizeSpecifications = (
  specs: ComponentSpecifications,
): NormalizedSpecifications => {
  // Helper to check if a value is non-zero and non-empty
  const asNumber = (s?: string) => {
    if (!s) return NaN;
    const num = parseFloat(String(s).replace(/[^\d.]/g, ''));
    return isNaN(num) ? NaN : num;
  };

  const nonZeroOrEmpty = (s?: string) => {
    const n = asNumber(s);
    return !!(s && (isNaN(n) || n > 0));
  };

  // Apply normalization to each field, filtering out zero/empty values
  return {
    voltage: nonZeroOrEmpty(specs.voltageRating)
      ? normalizeUnitText(specs.voltageRating!.trim())
      : '',
    current: nonZeroOrEmpty(specs.currentRating)
      ? normalizeUnitText(specs.currentRating!.trim())
      : '',
    power: nonZeroOrEmpty(specs.powerRating)
      ? normalizeUnitText(specs.powerRating!.trim())
      : '',
    inductance: nonZeroOrEmpty(specs.inductance)
      ? normalizeUnitText(specs.inductance!.trim())
      : '',
    capacitance: nonZeroOrEmpty(specs.capacitance)
      ? normalizeUnitText(specs.capacitance!.trim())
      : '',
    resistance: nonZeroOrEmpty(specs.resistance)
      ? normalizeUnitText(specs.resistance!.trim())
      : '',
    tolerance: nonZeroOrEmpty(specs.tolerance)
      ? normalizeUnitText(specs.tolerance!.trim())
      : '',
    saturationCurrent: nonZeroOrEmpty(specs.saturationCurrent)
      ? normalizeUnitText(specs.saturationCurrent!.trim())
      : '',
    packageOrMount: normalizeUnitText(
      (specs.packageType || specs.mountingType || '').trim(),
    ),
  };
};

/**
 * Interface for search strategy with keyword and weight
 */
export interface SearchStrategy {
  keyword: string;
  weight: number;
  strategyType:
    | 'exact_part'
    | 'bracket_text'
    | 'type_specs'
    | 'type_specific'
    | 'package_focus'
    | 'fallback'
    | 'ai_direct';
}

/**
 * Extract just the value and unit from bracket text, removing descriptive words
 * Examples:
 *   "2.4Ω Load" -> "2.4 Ohm"
 *   "47uH" -> "47 uH"
 *   "100uF 25V" -> "100 uF"
 */
export const extractValueFromBracketText = (bracketText: string): string => {
  // Normalize units first (Ω -> Ohm, µ -> u, etc.)
  let normalized = normalizeUnitText(bracketText);

  // Remove common descriptive words that aren't searchable
  normalized = normalized
    .replace(/\b(load|source|supply|output|input|cap)\b/gi, '')
    .trim();

  // Extract first occurrence of: number + unit pattern
  // Match: number (with optional decimal) + optional space + unit letters
  const valueMatch = normalized.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/);

  if (valueMatch) {
    return `${valueMatch[1]} ${valueMatch[2]}`;
  }

  // If no match, return the cleaned normalized text
  return normalized;
};

/**
 * Generate optimized search strategies based on parsed component information
 * Uses only the 2 most effective strategies to reduce API calls and avoid rate limiting
 * Returns strategies ordered by weight (highest first)
 */
export const generateSearchStrategies = (
  parsedName: ParsedComponentName,
  normalizedSpecs: NormalizedSpecifications,
  effectiveType: string,
): SearchStrategy[] => {
  const strategies: SearchStrategy[] = [];
  const type = effectiveType.toLowerCase();

  // Strategy 1: Exact Part Number (weight: 1.2)
  // Use parsed part number alone for exact matches - MOST EFFECTIVE for components with part numbers
  if (parsedName.partNumber) {
    strategies.push({
      keyword: parsedName.partNumber,
      weight: 1.2,
      strategyType: 'exact_part',
    });
  }

  // Strategy 2: Universal Search (weight: 1.0)
  // Extract value from bracket text - works for all component types
  let primarySpec = '';

  if (parsedName.bracketText) {
    // Extract the key value from bracket text (removes descriptive words)
    const extractedValue = extractValueFromBracketText(parsedName.bracketText);
    primarySpec = extractedValue;
  } else {
    // Fallback: use type + any available primary spec
    const primaryValue =
      normalizedSpecs.inductance ||
      normalizedSpecs.capacitance ||
      normalizedSpecs.resistance ||
      normalizedSpecs.voltage;
    primarySpec = [type, primaryValue].filter(Boolean).join(' ').trim();
  }

  if (primarySpec && primarySpec !== type) {
    strategies.push({
      keyword: primarySpec,
      weight: 1.0,
      strategyType: 'type_specs',
    });
  }

  // Filter out empty keywords and sort by weight (highest first)
  return strategies
    .filter((s) => s.keyword.trim().length > 0)
    .sort((a, b) => b.weight - a.weight);
};

/**
 * Rank and deduplicate results based on manufacturer + partNumber combination
 * Sort by searchStrategyWeight in descending order and slice to maxResults limit
 * Remove temporary searchStrategyWeight property before returning
 */
export const rankAndDeduplicateResults = (
  results: Array<ComponentOption & { searchStrategyWeight?: number }>,
  maxResults: number,
): ComponentOption[] => {
  // Step 1: Deduplicate based on manufacturer + partNumber combination
  // Keep the first occurrence (which will have the highest weight after sorting)
  const seen = new Set<string>();
  const uniqueResults: Array<
    ComponentOption & { searchStrategyWeight?: number }
  > = [];

  // First, sort by weight to ensure we keep the highest-weighted duplicate
  const sortedByWeight = [...results].sort(
    (a, b) => (b.searchStrategyWeight || 0) - (a.searchStrategyWeight || 0),
  );

  for (const result of sortedByWeight) {
    const key = `${result.manufacturer}|${result.partNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueResults.push(result);
    }
  }

  // Step 2: Sort by searchStrategyWeight in descending order (already sorted, but ensure it)
  const rankedResults = uniqueResults.sort(
    (a, b) => (b.searchStrategyWeight || 0) - (a.searchStrategyWeight || 0),
  );

  // Step 3: Slice to maxResults limit
  const limitedResults = rankedResults.slice(0, maxResults);

  // Step 4: Remove temporary searchStrategyWeight property before returning
  const finalResults: ComponentOption[] = limitedResults.map((result) => {
    const { searchStrategyWeight: _weight, ...cleanResult } = result;
    return cleanResult;
  });

  return finalResults;
};

/**
 * Generate a cache key for Mouser search results
 */
export function generateMouserCacheKey(
  componentName: string,
  specs: ComponentSpecifications,
): string {
  const normalizedSpecs = normalizeSpecifications(specs);
  const specString = JSON.stringify(
    normalizedSpecs,
    Object.keys(normalizedSpecs).sort(),
  );
  return `mouser_${componentName}_${specString}`;
}

/**
 * Search for components using specifications-based intelligent queries
 * Supports caching to reduce API calls and avoid rate limits
 */
export const extractPackageType = (part: MouserPart): string => {
  // Priority 1: Check ProductAttributes for package/case/pkg attributes using case-insensitive regex
  const packageAttr = part.ProductAttributes.find((attr) =>
    /package|case|pkg/i.test(attr.AttributeName),
  );
  if (packageAttr && packageAttr.AttributeValue) {
    return packageAttr.AttributeValue;
  }

  // Priority 2: Check ProductAttributes for mounting type attributes as fallback
  const mountingAttr = part.ProductAttributes.find((attr) =>
    /mounting/i.test(attr.AttributeName),
  );
  if (mountingAttr && mountingAttr.AttributeValue) {
    return mountingAttr.AttributeValue;
  }

  // Priority 3: Parse description for "IN {PACKAGE_NAME} PACKAGE" pattern
  const desc = part.Description.toUpperCase();
  const packageMatch = desc.match(/IN\s+([A-Z0-9- ]+?)\s+PACKAGE\b/);
  if (packageMatch && packageMatch[1]) {
    return packageMatch[1].trim();
  }

  // Priority 4: Parse description for common package codes (SOT-23, TO-220, 0805, 1206, etc.)
  const candidates = desc.match(/\b[A-Z\d-]{3,}\b/g) || [];
  const packageCandidates = candidates.filter((c) => /\d|-/.test(c));
  if (packageCandidates.length > 0) {
    // Take the last candidate as package is often mentioned at the end
    return packageCandidates[packageCandidates.length - 1];
  }

  // Priority 5: Check for general mounting keywords (SMD, Surface Mount, Through Hole, THT, DIP)
  if (/SMD|SURFACE MOUNT/.test(desc)) {
    return 'Surface Mount';
  }
  if (/THROUGH HOLE|THT|DIP/.test(desc)) {
    return 'Through Hole';
  }

  // Return "Unknown" if no package information is found
  return 'Unknown';
};

/**
 * Helper function to transform Mouser part data to ComponentOption
 */
export const transformMouserPartToComponentOption = (
  part: MouserPart,
  index: number,
  componentName: string,
): ComponentOption => {
  // Parse price breaks
  const pricingTiers = part.PriceBreaks.map((priceBreak) => ({
    quantity: priceBreak.Quantity,
    price: parseFloat(priceBreak.Price.replace(/[^0-9.-]+/g, '')) || 0,
  }));

  // Extract electrical specifications from ProductAttributes
  const electricalSpecs: { [key: string]: string } = {};
  part.ProductAttributes.forEach((attr) => {
    if (attr.AttributeName && attr.AttributeValue) {
      electricalSpecs[attr.AttributeName] = attr.AttributeValue;
    }
  });

  // Use new extractPackageType() function for package type extraction
  const mountingType = extractPackageType(part);

  // Determine the best datasheet link
  // Priority: DataSheetUrl > PDFUrl > ProductDetailUrl (as fallback)
  let datasheetLink = '';

  const hasDataSheetUrl = part.DataSheetUrl && part.DataSheetUrl.trim() !== '';
  const hasPDFUrl = part.PDFUrl && part.PDFUrl.trim() !== '';
  const hasProductDetailUrl =
    part.ProductDetailUrl && part.ProductDetailUrl.trim() !== '';

  if (hasDataSheetUrl) {
    datasheetLink = part.DataSheetUrl.trim();
  } else if (hasPDFUrl) {
    datasheetLink = part.PDFUrl.trim();
  } else if (hasProductDetailUrl) {
    // Use product detail page as fallback - it usually has datasheet links
    datasheetLink = part.ProductDetailUrl.trim();
  }

  return {
    id: `mouser-${componentName}-${part.MouserPartNumber}-${index}`,
    manufacturer: part.Manufacturer,
    partNumber: part.ManufacturerPartNumber,
    description: part.Description,
    mountingType, // Now more likely to be the actual package type
    availability: part.Availability || 'Unknown',
    pricingTiers,
    datasheetLink,
    electricalSpecs,
    isSelected: false,
    thumbnailImage: part.ImagePath || '',
    mouserPartNumber: part.MouserPartNumber,
    factoryStock: part.FactoryStock,
    leadTime: part.LeadTime,
    lifecycleStatus: part.LifecycleStatus,
    rohsStatus: part.ROHSStatus,
    ...(part.PriceBreaks[0]?.Currency
      ? { currency: part.PriceBreaks[0].Currency }
      : {}),
  };
};

/**
 * Sequential component search with rate limiting
 */
