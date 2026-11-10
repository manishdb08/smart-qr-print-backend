import { PDFDocument, degrees } from 'pdf-lib';

export interface PdfProcessResult {
  buffer: Buffer;
  pageCount: number;
  metadata: Record<string, unknown>;
}

export class DeterministicPdfProcessor {
  async processPdf(
    inputBuffer: Buffer,
    action: 'crop' | 'rotate' | 'remove_pages' | 'reorder_pages' | 'compress' | 'grayscale',
    params: Record<string, any>
  ): Promise<PdfProcessResult> {
    const pdfDoc = await PDFDocument.load(inputBuffer);
    const originalPageCount = pdfDoc.getPageCount();
    const metadata: Record<string, unknown> = { action, originalPageCount };

    switch (action) {
      case 'rotate': {
        const rotationDegrees = params.degrees ?? 90;
        const pagesToRotate = params.pageNumbers || Array.from({ length: originalPageCount }, (_, i) => i + 1);

        for (const pageNum of pagesToRotate) {
          if (pageNum >= 1 && pageNum <= originalPageCount) {
            const page = pdfDoc.getPage(pageNum - 1);
            const currentRotation = page.getRotation().angle;
            page.setRotation(degrees((currentRotation + rotationDegrees) % 360));
          }
        }
        metadata.rotatedPages = pagesToRotate;
        metadata.appliedRotation = rotationDegrees;
        break;
      }

      case 'crop': {
        const margin = params.marginPoints ?? 20;
        const pages = pdfDoc.getPages();
        for (const page of pages) {
          const { x, y, width, height } = page.getMediaBox();
          page.setCropBox(x + margin, y + margin, Math.max(10, width - margin * 2), Math.max(10, height - margin * 2));
        }
        metadata.cropMarginApplied = margin;
        break;
      }

      case 'remove_pages': {
        const pagesToRemove: number[] = (params.pageNumbers || [])
          .map((n: any) => parseInt(n, 10))
          .filter((n: number) => n >= 1 && n <= originalPageCount)
          .sort((a: number, b: number) => b - a); // Remove from back to front to keep indexes valid

        if (pagesToRemove.length >= originalPageCount) {
          throw new Error('Cannot remove all pages from a document.');
        }

        for (const pageNum of pagesToRemove) {
          pdfDoc.removePage(pageNum - 1);
        }
        metadata.removedPages = pagesToRemove;
        break;
      }

      case 'reorder_pages': {
        const newOrder: number[] = (params.pageOrder || []).map((n: any) => parseInt(n, 10));
        if (newOrder.length !== originalPageCount) {
          throw new Error(`Page order list must contain exactly ${originalPageCount} page indices.`);
        }

        const newDoc = await PDFDocument.create();
        for (const pageNum of newOrder) {
          if (pageNum < 1 || pageNum > originalPageCount) {
            throw new Error(`Invalid page index ${pageNum}. Must be between 1 and ${originalPageCount}.`);
          }
          const [copiedPage] = await newDoc.copyPages(pdfDoc, [pageNum - 1]);
          newDoc.addPage(copiedPage);
        }

        const reorderedBuffer = Buffer.from(await newDoc.save());
        return {
          buffer: reorderedBuffer,
          pageCount: newDoc.getPageCount(),
          metadata: { action, reordered: newOrder },
        };
      }

      case 'compress': {
        // PDF-lib optimizes references and drops unused objects upon save
        metadata.compressed = true;
        break;
      }

      case 'grayscale': {
        metadata.grayscaleFilter = 'client-monochrome-optimized';
        break;
      }

      default:
        throw new Error(`Unsupported PDF deterministic action: ${action}`);
    }

    const savedBytes = await pdfDoc.save({ useObjectStreams: true });
    const buffer = Buffer.from(savedBytes);

    return {
      buffer,
      pageCount: pdfDoc.getPageCount(),
      metadata,
    };
  }
}

export const deterministicPdfProcessor = new DeterministicPdfProcessor();
