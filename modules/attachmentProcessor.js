import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { genAI, TEMP_DIR } from '../botManager.js';
import { delay } from '../tools/others.js';

export async function processAttachment(attachment, userId, interactionId) {
  const contentType = (attachment.contentType || "").toLowerCase();
  const fileExtension = path.extname(attachment.name).toLowerCase();

  const apiUploadableTypes = {
    images: {
      extensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heif', '.tiff', '.bmp'],
      mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heif', 'image/tiff', 'image/bmp']
    },
    video: {
      extensions: ['.mp4', '.mov', '.mpeg', '.mpg', '.webm', '.avi', '.wmv', '.3gpp', '.flv'],
      mimeTypes: ['video/mp4', 'video/quicktime', 'video/mpeg', 'video/mpg', 'video/webm', 
                  'video/x-msvideo', 'video/x-ms-wmv', 'video/3gpp', 'video/x-flv', 'video/mpegps']
    },
    audio: {
      extensions: ['.mp3', '.wav', '.aiff', '.aac', '.ogg', '.flac', '.m4a', '.opus'],
      mimeTypes: ['audio/mp3', 'audio/wav', 'audio/aiff', 'audio/aac', 'audio/ogg', 
                  'audio/flac', 'audio/m4a', 'audio/mpeg', 'audio/mpga', 'audio/opus', 
                  'audio/pcm', 'audio/webm', 'audio/mp4']
    },
    uploadableDocs: {
      extensions: ['.pdf'],
      mimeTypes: ['application/pdf', 'application/x-pdf']
    },
    plainText: {
      extensions: ['.txt'],
      mimeTypes: ['text/plain']
    }
  };

  const convertibleImages = {
    extensions: ['.svg', '.avif', '.ico', '.psd', '.eps', '.raw', '.cr2', '.nef'],
    mimeTypes: ['image/svg+xml', 'image/avif', 'image/x-icon', 'image/vnd.adobe.photoshop']
  };

  const convertibleAudio = {
    extensions: ['.wma', '.amr', '.mid', '.midi', '.ra'],
    mimeTypes: ['audio/x-ms-wma', 'audio/amr', 'audio/midi', 'audio/x-realaudio']
  };

  const convertibleVideo = {
    extensions: ['.mkv', '.vob', '.ogv', '.ts', '.m2ts', '.divx'],
    mimeTypes: ['video/x-matroska', 'video/mpeg', 'video/ogg', 'video/mp2t']
  };

  const textExtractionTypes = {
    extensions: ['.doc', '.docx', '.xls', '.xlsx', '.csv', '.tsv', '.pptx', '.rtf', 
                 '.html', '.py', '.java', '.js', '.css', '.json', '.xml', '.sql', '.log', '.md',
                 '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs', '.swift', 
                 '.kt', '.scala', '.sh', '.bat', '.yml', '.yaml', '.ini', '.cfg', '.conf'],
    mimeTypes: ['application/msword', 
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'text/csv', 'text/tab-separated-values',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'application/rtf', 'text/html', 'text/markdown', 'application/json',
                'application/xml', 'text/x-python', 'text/x-java', 'text/javascript',
                'text/css', 'application/x-sql']
  };

  const unsupportedTypes = {
    extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', 
                 '.exe', '.dll', '.bin', '.dmg', '.pkg', '.deb', '.rpm',
                 '.iso', '.img', '.msi', '.apk', '.jar',
                 '.db', '.sqlite', '.mdb', '.accdb'],
    mimeTypes: ['application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
                'application/x-tar', 'application/gzip', 'application/x-executable',
                'application/x-msdownload', 'application/vnd.microsoft.portable-executable',
                'application/x-iso9660-image']
  };

  const sanitizedFileName = sanitizeFileName(attachment.name);
  const uniqueTempFilename = `${userId}-${interactionId}-${Date.now()}-${sanitizedFileName}`;
  const filePath = path.join(TEMP_DIR, uniqueTempFilename);

  const isUnsupported = 
    unsupportedTypes.extensions.includes(fileExtension) ||
    unsupportedTypes.mimeTypes.includes(contentType);

  if (isUnsupported) {
    console.warn(`Unsupported file type: ${attachment.name} (${contentType})`);
    return {
      text: `\n\n[❌ Unsupported File Type: ${attachment.name}]\nThis file format cannot be processed. Supported formats include: images, videos, audio, PDFs, text files, and office documents.`
    };
  }

  const canUploadToAPI = 
    apiUploadableTypes.images.extensions.includes(fileExtension) ||
    apiUploadableTypes.images.mimeTypes.includes(contentType) ||
    apiUploadableTypes.video.extensions.includes(fileExtension) ||
    apiUploadableTypes.video.mimeTypes.includes(contentType) ||
    apiUploadableTypes.audio.extensions.includes(fileExtension) ||
    apiUploadableTypes.audio.mimeTypes.includes(contentType) ||
    apiUploadableTypes.uploadableDocs.extensions.includes(fileExtension) ||
    apiUploadableTypes.uploadableDocs.mimeTypes.includes(contentType) ||
    apiUploadableTypes.plainText.extensions.includes(fileExtension) ||
    apiUploadableTypes.plainText.mimeTypes.includes(contentType);

  if (canUploadToAPI) {
    try {
      await downloadFile(attachment.url, filePath);
      
      const isGif = contentType === 'image/gif' || fileExtension === '.gif';
      const isAnimatedSticker = attachment.isSticker && attachment.isAnimated;
      const isAnimatedEmoji = attachment.isEmoji && attachment.isAnimated;

      if ((isGif || isAnimatedSticker || isAnimatedEmoji) && !contentType.includes('video')) {
        const mp4FilePath = filePath.replace(/\.(gif|png|jpg|jpeg)$/i, '.mp4');
        
        try {
          await new Promise((resolve, reject) => {
            ffmpeg(filePath)
              .outputOptions([
                '-movflags', 'faststart',
                '-pix_fmt', 'yuv420p',
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
              ])
              .output(mp4FilePath)
              .on('end', resolve)
              .on('error', reject)
              .run();
          });
          
          // ✅ CORRECT SDK: Use 'path' not 'file'
          const uploadResult = await genAI.files.upload({
            path: mp4FilePath,
            config: {
              mimeType: 'video/mp4',
              displayName: sanitizedFileName.replace(/\.gif$/i, '.mp4'),
            }
          });

          const name = uploadResult.name;
          if (!name) {
            throw new Error(`Unable to extract file name from upload result.`);
          }

          let file = await genAI.files.get({ name: name });
          let attempts = 0;
          while (file.state === 'PROCESSING' && attempts < 60) {
            await delay(10000);
            file = await genAI.files.get({ name: name });
            attempts++;
          }
          
          if (file.state === 'FAILED') {
            throw new Error(`Video processing failed for ${sanitizedFileName}.`);
          }

          await fs.unlink(filePath).catch(() => {});
          await fs.unlink(mp4FilePath).catch(() => {});
          
          // ✅ Return fileUri format
          return {
            fileUri: uploadResult.uri,
            mimeType: uploadResult.mimeType
          };
          
        } catch (gifError) {
          console.error('Error converting GIF to MP4:', gifError);
          
          try {
            const sharp = (await import('sharp')).default;
            const pngFilePath = filePath.replace(/\.gif$/i, '.png');
            await sharp(filePath, { animated: false })
              .png()
              .toFile(pngFilePath);
            
            const uploadResult = await genAI.files.upload({
              path: pngFilePath,
              config: {
                mimeType: 'image/png',
                displayName: sanitizedFileName.replace(/\.gif$/i, '.png'),
              }
            });
            
            await fs.unlink(filePath).catch(() => {});
            await fs.unlink(pngFilePath).catch(() => {});
            
            return {
              fileUri: uploadResult.uri,
              mimeType: uploadResult.mimeType
            };
          } catch (fallbackError) {
            throw gifError;
          }
        }
      }
      
      let mimeType = contentType || attachment.contentType;
      
      if (!mimeType || mimeType === 'application/octet-stream') {
        const mimeMap = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.heif': 'image/heif',
          '.tiff': 'image/tiff',
          '.bmp': 'image/bmp',
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.avi': 'video/x-msvideo',
          '.webm': 'video/webm',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.aac': 'audio/aac',
          '.ogg': 'audio/ogg',
          '.flac': 'audio/flac',
          '.m4a': 'audio/mp4',
          '.pdf': 'application/pdf',
          '.txt': 'text/plain'
        };
        mimeType = mimeMap[fileExtension] || 'application/octet-stream';
      }
      
      // ✅ CORRECT SDK: Use 'path' not 'file'
      const uploadResult = await genAI.files.upload({
        path: filePath,
        config: {
          mimeType: mimeType,
          displayName: sanitizedFileName,
        }
      });

      const name = uploadResult.name;
      if (!name) {
        throw new Error(`Unable to extract file name from upload result.`);
      }

      if (apiUploadableTypes.video.extensions.includes(fileExtension) || 
          apiUploadableTypes.video.mimeTypes.includes(contentType)) {
        let file = await genAI.files.get({ name: name });
        let attempts = 0;
        while (file.state === 'PROCESSING' && attempts < 60) {
          await delay(10000);
          file = await genAI.files.get({ name: name });
          attempts++;
        }
        if (file.state === 'FAILED') {
          throw new Error(`Video processing failed for ${sanitizedFileName}.`);
        }
      }

      await fs.unlink(filePath).catch(() => {});
      
      // ✅ Return ONLY fileUri format (no metadata text)
      return {
        fileUri: uploadResult.uri,
        mimeType: uploadResult.mimeType
      };
      
    } catch (uploadError) {
      console.error(`Error uploading ${attachment.name} to API:`, uploadError);
      await fs.unlink(filePath).catch(() => {});
      throw uploadError;
    }
  }

  const isConvertibleImage = 
    convertibleImages.extensions.includes(fileExtension) ||
    convertibleImages.mimeTypes.includes(contentType);

  if (isConvertibleImage) {
    try {
      await downloadFile(attachment.url, filePath);
      const sharp = (await import('sharp')).default;
      const pngFilePath = filePath.replace(/\.[^.]+$/, '.png');
      
      await sharp(filePath)
        .png()
        .toFile(pngFilePath);
      
      const uploadResult = await genAI.files.upload({
        path: pngFilePath,
        config: {
          mimeType: 'image/png',
          displayName: sanitizedFileName.replace(/\.[^.]+$/, '.png'),
        }
      });

      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(pngFilePath).catch(() => {});
      
      return {
        fileUri: uploadResult.uri,
        mimeType: 'image/png'
      };
      
    } catch (conversionError) {
      console.error(`Error converting image ${attachment.name}:`, conversionError);
      await fs.unlink(filePath).catch(() => {});
      return {
        text: `\n\n[❌ Failed to convert image: ${attachment.name}]`
      };
    }
  }

  const isConvertibleAudio = 
    convertibleAudio.extensions.includes(fileExtension) ||
    convertibleAudio.mimeTypes.includes(contentType);

  if (isConvertibleAudio) {
    try {
      await downloadFile(attachment.url, filePath);
      const mp3FilePath = filePath.replace(/\.[^.]+$/, '.mp3');
      
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .toFormat('mp3')
          .audioCodec('libmp3lame')
          .audioBitrate('192k')
          .output(mp3FilePath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      const uploadResult = await genAI.files.upload({
        path: mp3FilePath,
        config: {
          mimeType: 'audio/mpeg',
          displayName: sanitizedFileName.replace(/\.[^.]+$/, '.mp3'),
        }
      });

      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(mp3FilePath).catch(() => {});
      
      return {
        fileUri: uploadResult.uri,
        mimeType: 'audio/mpeg'
      };
      
    } catch (conversionError) {
      console.error(`Error converting audio ${attachment.name}:`, conversionError);
      await fs.unlink(filePath).catch(() => {});
      return {
        text: `\n\n[❌ Failed to convert audio: ${attachment.name}]`
      };
    }
  }

  const isConvertibleVideo = 
    convertibleVideo.extensions.includes(fileExtension) ||
    convertibleVideo.mimeTypes.includes(contentType);

  if (isConvertibleVideo) {
    try {
      await downloadFile(attachment.url, filePath);
      const mp4FilePath = filePath.replace(/\.[^.]+$/, '.mp4');
      
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .outputOptions([
            '-movflags', 'faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
          ])
          .videoCodec('libx264')
          .audioCodec('aac')
          .output(mp4FilePath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      const uploadResult = await genAI.files.upload({
        path: mp4FilePath,
        config: {
          mimeType: 'video/mp4',
          displayName: sanitizedFileName.replace(/\.[^.]+$/, '.mp4'),
        }
      });

      const name = uploadResult.name;
      let file = await genAI.files.get({ name: name });
      let attempts = 0;
      while (file.state === 'PROCESSING' && attempts < 60) {
        await delay(10000);
        file = await genAI.files.get({ name: name });
        attempts++;
      }
      
      if (file.state === 'FAILED') {
        throw new Error(`Video processing failed.`);
      }

      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(mp4FilePath).catch(() => {});
      
      return {
        fileUri: uploadResult.uri,
        mimeType: 'video/mp4'
      };
      
    } catch (conversionError) {
      console.error(`Error converting video ${attachment.name}:`, conversionError);
      await fs.unlink(filePath).catch(() => {});
      return {
        text: `\n\n[❌ Failed to convert video: ${attachment.name}]`
      };
    }
  }

  const needsTextExtraction = 
    textExtractionTypes.extensions.includes(fileExtension) ||
    textExtractionTypes.mimeTypes.includes(contentType);

  if (needsTextExtraction) {
    try {
      const { downloadAndReadFile } = await import('./utils.js');
      let fileContent = await downloadAndReadFile(attachment.url, fileExtension);
      
      const txtFileName = sanitizedFileName.replace(/\.[^.]+$/, '.txt');
      const txtFilePath = path.join(TEMP_DIR, `extracted-${uniqueTempFilename}.txt`);
      
      await fs.writeFile(txtFilePath, fileContent, 'utf8');
      
      const uploadResult = await genAI.files.upload({
        path: txtFilePath,
        config: {
          mimeType: 'text/plain',
          displayName: txtFileName,
        }
      });

      await fs.unlink(txtFilePath).catch(() => {});
      
      return {
        fileUri: uploadResult.uri,
        mimeType: 'text/plain'
      };
      
    } catch (extractionError) {
      console.error(`Error extracting text from ${attachment.name}:`, extractionError);
      return {
        text: `\n\n[❌ Failed to extract text from: ${attachment.name}]`
      };
    }
  }

  console.warn(`Unhandled file type: ${attachment.name} (${contentType})`);
  return {
    text: `\n\n[⚠️ Unknown file format: ${attachment.name}]`
  };
}

async function downloadFile(url, filePath) {
  const writer = createWriteStream(filePath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function sanitizeFileName(fileName) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
              }
