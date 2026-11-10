import sharp from 'sharp';

export interface ImageProcessResult {
  buffer: Buffer;
  metadata: Record<string, unknown>;
}

export class DeterministicImageProcessor {
  async processImage(
    inputBuffer: Buffer,
    action: 'crop' | 'rotate' | 'compress' | 'grayscale' | 'basic_color_correction',
    params: Record<string, any>
  ): Promise<ImageProcessResult> {
    let pipeline = sharp(inputBuffer);
    const metadata: Record<string, unknown> = { action };

    switch (action) {
      case 'rotate': {
        const degrees = params.degrees ?? 90;
        pipeline = pipeline.rotate(degrees);
        metadata.appliedRotation = degrees;
        break;
      }

      case 'crop': {
        const { left, top, width, height } = params;
        if (typeof left === 'number' && typeof top === 'number' && width && height) {
          pipeline = pipeline.extract({ left, top, width, height });
          metadata.crop = { left, top, width, height };
        } else {
          // Default trim / margin crop
          pipeline = pipeline.trim();
          metadata.crop = 'auto-trim';
        }
        break;
      }

      case 'grayscale': {
        pipeline = pipeline.grayscale();
        metadata.grayscale = true;
        break;
      }

      case 'basic_color_correction': {
        const brightness = params.brightness ?? 1.0;
        const saturation = params.saturation ?? 1.0;
        pipeline = pipeline.modulate({ brightness, saturation });
        metadata.colorCorrection = { brightness, saturation };
        break;
      }

      case 'compress': {
        pipeline = pipeline.jpeg({ quality: 80, progressive: true });
        metadata.compressed = true;
        break;
      }

      default:
        throw new Error(`Unsupported Image deterministic action: ${action}`);
    }

    const processedBuffer = await pipeline.toBuffer();
    return {
      buffer: processedBuffer,
      metadata,
    };
  }
}

export const deterministicImageProcessor = new DeterministicImageProcessor();
