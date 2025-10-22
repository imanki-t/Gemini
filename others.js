// others.js
import {
  EmbedBuilder
} from 'discord.js';
import config from './config.js';
import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import {
  TEMP_DIR
} from './botManager.js';

ffmpeg.setFfmpegPath(ffmpegStatic);

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retryOperation(fn, maxRetries, delayMs = 1000) {
  let error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      error = err;
      if (attempt < maxRetries) {
        await delay(delayMs);
      }
    }
  }
  throw new Error(`Operation failed after ${maxRetries} attempts: ${error.message}`);
}

export function createErrorEmbed(message) {
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('Error')
    .setDescription(message)
    .setTimestamp();
}

export function createSuccessEmbed(message) {
  return new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('Success')
    .setDescription(message)
    .setTimestamp();
}

export function createProcessingEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x00FFFF)
    .setTitle(title)
    .setDescription(description)
    .setFooter({
      text: 'Processing your request...'
    });
}

export function createSettingsEmbed(title, description, user) {
  return new EmbedBuilder()
    .setColor(config.hexColour)
    .setTitle(title)
    .setDescription(description)
    .setAuthor({
      name: user.displayName,
      iconURL: user.displayAvatarURL()
    })
    .setTimestamp();
}

export async function processGif(filePath) {
  const outputDir = path.join(TEMP_DIR, `gif_frames_${Date.now()}`);
  await fs.mkdir(outputDir, {
    recursive: true
  });
  const outputPath = path.join(outputDir, 'frame-%03d.png');

  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions(['-vf', 'fps=1', '-vsync', 'vfr'])
      .output(outputPath)
      .on('end', async () => {
        try {
          const files = await fs.readdir(outputDir);
          const framePaths = files
            .filter(f => f.endsWith('.png'))
            .map(f => path.join(outputDir, f))
            .sort();
          resolve(framePaths);
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (err) => {
        reject(new Error(`FFmpeg error processing GIF: ${err.message}`));
      })
      .run();
  });
}

export async function processAudio(filePath) {
  const outputFormat = 'mp3';
  const outputPath = `${filePath}.${outputFormat}`;

  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .output(outputPath)
      .audioCodec('libmp3lame')
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(new Error(`FFmpeg error processing audio: ${err.message}`));
      })
      .run();
  });
}

export async function processVideo(filePath) {
  const outputFormat = 'mp3';
  const outputPath = `${filePath}_audio.mp3`;

  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .output(outputPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(new Error(`FFmpeg error processing video: ${err.message}`));
      })
      .run();
  });
}

export async function cleanupTempFiles(files) {
  if (!Array.isArray(files)) {
    files = [files];
  }
  for (const file of files) {
    if (typeof file === 'string') {
      try {
        const stats = await fs.stat(file);
        if (stats.isDirectory()) {
          await fs.rm(file, {
            recursive: true,
            force: true
          });
        } else {
          await fs.unlink(file);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`Error cleaning up temp file/dir ${file}:`, err);
        }
      }
    }
  }
      }
