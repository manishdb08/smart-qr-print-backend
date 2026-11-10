import crypto from 'node:crypto';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { config } from '../config/index.js';

export interface FileValidationResult {
  isValid: boolean;
  actualMimeType: string;
  actualExtension: string;
  checksumSha256: string;
  fileSizeBytes: number;
  pageCount: number;
  metadata: Record<string, unknown>;
}

export function detectMagicBytesMimeType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // PDF: %PDF (0x25 0x50 0x44 0x46)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'application/pdf';
  }

  // PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: 0xFF 0xD8 0xFF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: RIFF (bytes 0..3) ... WEBP (bytes 8..11)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

export async function validateAndInspectFile(
  buffer: Buffer,
  originalFilename: string,
  declaredMimeType: string
): Promise<FileValidationResult> {
  // 1. File size checks
  const fileSizeBytes = buffer.length;
  if (fileSizeBytes === 0) {
    const error = new Error('Uploaded file is empty (0 bytes).');
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  if (fileSizeBytes > config.MAX_FILE_SIZE_BYTES) {
    const error = new Error(
      `File size (${fileSizeBytes} bytes) exceeds maximum allowable limit of ${config.MAX_FILE_SIZE_BYTES} bytes.`
    );
    (error as unknown as { statusCode: number }).statusCode = 413;
    throw error;
  }

  // 2. Magic bytes validation (Prevent extension/MIME spoofing)
  const actualMimeType = detectMagicBytesMimeType(buffer);
  if (!actualMimeType) {
    const error = new Error('File format not recognized or unsupported magic bytes.');
    (error as unknown as { statusCode: number }).statusCode = 415;
    throw error;
  }

  const allowedList = config.ALLOWED_MIME_TYPES.split(',').map((m) => m.trim());
  if (!allowedList.includes(actualMimeType)) {
    const error = new Error(`File MIME type '${actualMimeType}' is not permitted for printing.`);
    (error as unknown as { statusCode: number }).statusCode = 415;
    throw error;
  }

  // 3. Extension validation
  const ext = path.extname(originalFilename).toLowerCase();
  const validExtensionsForMime: Record<string, string[]> = {
    'application/pdf': ['.pdf'],
    'image/png': ['.png'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/webp': ['.webp'],
  };

  const expectedExts = validExtensionsForMime[actualMimeType] || [];
  if (!expectedExts.includes(ext)) {
    const error = new Error(
      `File extension '${ext}' does not match actual detected MIME type '${actualMimeType}'. Expected one of: ${expectedExts.join(', ')}`
    );
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  // 4. SHA-256 Checksum Calculation
  const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // 5. Page count and Content Integrity Verification
  let pageCount = 1;
  const metadata: Record<string, unknown> = {
    detectedMimeType: actualMimeType,
    extension: ext,
  };

  if (actualMimeType === 'application/pdf') {
    try {
      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: false });
      pageCount = pdfDoc.getPageCount();

      if (pageCount < 1) {
        throw new Error('PDF document contains no renderable pages.');
      }

      metadata.pageCount = pageCount;
      metadata.pdfTitle = pdfDoc.getTitle() ?? undefined;
      metadata.pdfAuthor = pdfDoc.getAuthor() ?? undefined;
    } catch (pdfErr) {
      const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      const isEncrypted = msg.toLowerCase().includes('encrypt') || msg.toLowerCase().includes('password');
      const err = new Error(
        isEncrypted
          ? 'Password-protected or encrypted PDFs cannot be accepted for printing. Please remove encryption first.'
          : `Corrupted or invalid PDF file: ${msg}`
      );
      (err as unknown as { statusCode: number }).statusCode = 422;
      throw err;
    }
  } else {
    // Image validation via Sharp
    try {
      const imageMetadata = await sharp(buffer).metadata();
      metadata.width = imageMetadata.width;
      metadata.height = imageMetadata.height;
      metadata.format = imageMetadata.format;
      metadata.space = imageMetadata.space;
      pageCount = 1;
    } catch (imgErr) {
      const msg = imgErr instanceof Error ? imgErr.message : String(imgErr);
      const err = new Error(`Corrupted image file: ${msg}`);
      (err as unknown as { statusCode: number }).statusCode = 422;
      throw err;
    }
  }

  return {
    isValid: true,
    actualMimeType,
    actualExtension: ext,
    checksumSha256,
    fileSizeBytes,
    pageCount,
    metadata,
  };
}
