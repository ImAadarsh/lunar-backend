import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { env } from '../config/env.js';

export async function processUploadedMedia({ filePath, filename, mime }) {
  const isImage = typeof mime === 'string' && mime.startsWith('image/');
  if (!isImage) {
    return {
      storageProvider: 'local',
      objectKey: filename,
      processingStatus: 'validated',
      scanStatus: 'skipped',
      processingNote: 'Non-image upload stored without compression.',
    };
  }
  const parsed = path.parse(filename);
  const processedName = `${parsed.name}-processed.webp`;
  const processedPath = path.join(path.dirname(filePath), processedName);
  await sharp(filePath).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 82 }).toFile(processedPath);
  try {
    fs.unlinkSync(filePath);
  } catch {}
  return {
    storageProvider: env.mediaStorageProvider || 'local',
    objectKey: processedName,
    storageKey: processedName,
    filePath: processedPath,
    mime: 'image/webp',
    sizeBytes: fs.statSync(processedPath).size,
    processingStatus: 'validated',
    scanStatus: 'skipped',
    processingNote: 'Image compressed and validated locally. Configure object storage and AV scanning for production.',
  };
}
