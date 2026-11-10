import { PRICING_RULES } from '../../config/index.js';

export interface CalculateQuoteInput {
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex: boolean;
  pageSize: string;
  pageRange: string;
  printerCapabilities: {
    supportsColor: boolean;
    supportsMono: boolean;
    supportsDuplex: boolean;
    supportedPageSizes: string[];
    maxDpi: number;
  };
}

export interface CalculatedQuoteResult {
  pricingRuleVersion: string;
  baseMonoPagePaise: number;
  baseColorPagePaise: number;
  duplexDiscountPercent: number;
  minOrderPaise: number;
  calculatedPages: number;
  copies: number;
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalAmountPaise: number;
  currency: string;
}

export function parsePageRangeCount(pageRange: string, totalDocumentPages: number): number {
  const trimmed = pageRange.trim().toLowerCase();
  if (trimmed === 'all' || trimmed === '') {
    return totalDocumentPages;
  }

  const selectedPages = new Set<number>();
  const parts = trimmed.split(/[,;\s]+/);

  for (const part of parts) {
    if (!part) continue;
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
        throw new Error(`Invalid page range syntax: '${part}'.`);
      }
      for (let i = start; i <= Math.min(end, totalDocumentPages); i++) {
        selectedPages.add(i);
      }
    } else {
      const pageNum = parseInt(part, 10);
      if (isNaN(pageNum) || pageNum < 1) {
        throw new Error(`Invalid page number: '${part}'.`);
      }
      if (pageNum <= totalDocumentPages) {
        selectedPages.add(pageNum);
      }
    }
  }

  if (selectedPages.size === 0) {
    throw new Error(`Selected page range '${pageRange}' yields 0 valid pages for a ${totalDocumentPages}-page document.`);
  }

  return selectedPages.size;
}

export function calculatePriceQuote(input: CalculateQuoteInput): CalculatedQuoteResult {
  const caps = input.printerCapabilities;

  // 1. Hardware Capability Compatibility Checks
  if (input.isColor && !caps.supportsColor) {
    const error = new Error('Printer hardware capability error: Selected printer does not support color printing.');
    (error as unknown as { statusCode: number }).statusCode = 422;
    throw error;
  }

  if (!input.isColor && !caps.supportsMono) {
    const error = new Error('Printer hardware capability error: Selected printer does not support monochrome printing.');
    (error as unknown as { statusCode: number }).statusCode = 422;
    throw error;
  }

  if (input.isDuplex && !caps.supportsDuplex) {
    const error = new Error('Printer hardware capability error: Selected printer does not support duplex (double-sided) printing.');
    (error as unknown as { statusCode: number }).statusCode = 422;
    throw error;
  }

  const normalizedPageSize = input.pageSize.toUpperCase();
  const supportedSizes = caps.supportedPageSizes.map((s) => s.toUpperCase());
  if (!supportedSizes.includes(normalizedPageSize)) {
    const error = new Error(
      `Printer hardware capability error: Paper size '${input.pageSize}' is not supported by printer. Supported sizes: [${caps.supportedPageSizes.join(', ')}].`
    );
    (error as unknown as { statusCode: number }).statusCode = 422;
    throw error;
  }

  // 2. Validate copies count
  const copies = Math.min(Math.max(1, input.copies || 1), 100);

  // 3. Page count resolution
  const effectivePagesPerCopy = parsePageRangeCount(input.pageRange, input.pageCount);
  const totalSheetsOrPages = effectivePagesPerCopy * copies;

  // 4. Rate per page (strictly integer paise)
  const unitPricePaise = input.isColor
    ? PRICING_RULES.baseColorPagePaise
    : PRICING_RULES.baseMonoPagePaise;

  const subtotalPaise = totalSheetsOrPages * unitPricePaise;

  // 5. Duplex Discount (10% discount)
  let discountPaise = 0;
  if (input.isDuplex) {
    discountPaise = Math.round((subtotalPaise * PRICING_RULES.duplexDiscountPercent) / 100);
  }

  // 6. Tax calculation (if applicable, integer paise)
  const taxPaise = 0;

  // 7. Total before minimum constraint
  const totalBeforeMin = subtotalPaise - discountPaise + taxPaise;

  // 8. Enforce minimum order constraint (200 paise = 2 INR)
  const totalAmountPaise = Math.max(totalBeforeMin, PRICING_RULES.minOrderPaise);

  return {
    pricingRuleVersion: PRICING_RULES.version,
    baseMonoPagePaise: PRICING_RULES.baseMonoPagePaise,
    baseColorPagePaise: PRICING_RULES.baseColorPagePaise,
    duplexDiscountPercent: PRICING_RULES.duplexDiscountPercent,
    minOrderPaise: PRICING_RULES.minOrderPaise,
    calculatedPages: effectivePagesPerCopy,
    copies,
    subtotalPaise,
    discountPaise,
    taxPaise,
    totalAmountPaise,
    currency: PRICING_RULES.currency,
  };
}
