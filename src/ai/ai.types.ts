export interface ExtractedPrintSettings {
  copies: number;
  isColor: boolean;
  isDuplex: boolean;
  pageSize: string;
  pageRange: string;
  orientation?: 'portrait' | 'landscape';
  fitToPage?: boolean;
}

export interface SummarizeResult {
  summary: string;
  keyPoints: string[];
  detectedLanguage?: string;
}

export interface TranslateResult {
  translatedText: string;
  sourceLanguage?: string;
  targetLanguage: string;
}

export interface OcrResult {
  text: string;
  confidenceScore: number;
}

export interface GeminiAdapter {
  summarize(content: string | Buffer, mimeType: string): Promise<SummarizeResult>;
  translate(content: string | Buffer, mimeType: string, targetLanguage: string): Promise<TranslateResult>;
  performOcr(content: Buffer, mimeType: string): Promise<OcrResult>;
  extractPrintSettings(userPrompt: string): Promise<ExtractedPrintSettings>;
}
