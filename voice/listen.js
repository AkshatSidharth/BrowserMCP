'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { OpenAI } = require('openai');
const logger = require('../logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const RECORD_SECONDS = parseInt(process.env.VOICE_RECORD_SECONDS || '5', 10);

// ─── Demo mode: read text from stdin ─────────────────────────────────────────

/**
 * Prompt the user to type a command in demo mode (no microphone required).
 * Returns the entered text, or null if the user typed "exit".
 */
async function getTextInput(prompt = 'Command> ') {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  return new Promise((resolve) => {
    process.stdout.write(prompt);
    rl.once('line', (line) => {
      rl.close();
      const text = line.trim();
      resolve(text || null);
    });
    rl.once('close', () => resolve(null));
  });
}

// ─── Voice mode: record from mic and transcribe via Whisper ──────────────────

/**
 * Record audio from the default microphone for RECORD_SECONDS seconds,
 * save it to a temp WAV file, then transcribe via OpenAI Whisper.
 *
 * Prerequisites (system):
 *   macOS  → no extra install needed (uses CoreAudio via sox)
 *   Linux  → sudo apt install sox libsox-fmt-all
 *   Windows → install sox: https://sourceforge.net/projects/sox/
 */
async function recordAndTranscribe() {
  const recorder = require('node-record-lpcm16');
  const tmpFile = path.join(os.tmpdir(), `mcp-voice-${Date.now()}.wav`);

  logger.info(`Recording for ${RECORD_SECONDS}s ... (speak now)`);

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmpFile, { encoding: 'binary' });

    const recording = recorder.record({
      sampleRate: 16000,
      channels: 1,
      audioType: 'wav',
    });

    recording.stream().pipe(file);

    setTimeout(() => {
      recording.stop();
      file.end();
      resolve();
    }, RECORD_SECONDS * 1000);

    recording.stream().on('error', reject);
  });

  logger.info('Recording done. Transcribing ...');
  return transcribeFile(tmpFile);
}

/**
 * Send an audio file to OpenAI Whisper and return the transcription.
 * Cleans up the temp file afterward.
 */
async function transcribeFile(filePath) {
  try {
    const response = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(filePath),
      language: 'en',
    });
    const text = response.text.trim();
    logger.info(`Transcribed: "${text}"`);
    return text;
  } finally {
    // Always clean up temp file
    fs.unlink(filePath, () => {});
  }
}

module.exports = { recordAndTranscribe, transcribeFile, getTextInput };
