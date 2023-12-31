// Related: https://github.com/deepgram/median-streaming-latency/blob/main/latency.py

import path from "path";
import fs from "fs";
import { WaveFile } from "wavefile";
import { Deepgram } from "@deepgram/sdk";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

// Deepgram streaming options
const ENDPOINTING = true;
const ENDPOINT_SILENCE_MS = 10;
const INTERIM_RESULTS = false; // This really just enables/disables partial results (is_final=false)

// It is not recommended to modify these values unless you want to use a different audio file
const AUDIO_FILE = "mulaw-8bit-8khz.wav";
const AUDIO_FILE_SAMPLE_RATE = 8000;
const AUDIO_FILE_BIT_RATE = "8m";
const AUDIO_FILE_ENCODING = "mulaw";
const CHUNK_BYTES = 200;

const createChunks = (buffer: Buffer, chunkBytes: number) => {
  const chunks = [];
  const len = buffer.length;

  let i = 0;

  while (i < len) {
    chunks.push(buffer.slice(i, (i += chunkBytes)));
  }

  return chunks;
};

const resolveAfter = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const main = async () => {
  console.log("Starting");

  console.log("Deepgram options", {
    endpointing: ENDPOINTING,
    endpointSilenceMs: ENDPOINT_SILENCE_MS,
    interimResults: INTERIM_RESULTS,
  });

  // Setup Deepgram streaming websocket connection
  const deepgram = new Deepgram(DEEPGRAM_API_KEY);

  const transcriber = deepgram.transcription.live({
    interim_results: INTERIM_RESULTS,
    encoding: AUDIO_FILE_ENCODING,
    sample_rate: AUDIO_FILE_SAMPLE_RATE,
    endpointing: ENDPOINTING ? ENDPOINT_SILENCE_MS : false,
    // Don't change these
    smart_format: true,
    punctuate: true,
    language: "en-US",
    tier: "nova",
    model: "phonecall",
  });

  transcriber.addListener("close", () => {
    console.log("Deepgram connection closed");
  });

  let startTime: number | undefined;
  let count = 0;

  transcriber.addListener("transcriptReceived", (message: any) => {
    // Immediately capture the current time so that nothing else impacts the duration calculation
    const currTime = Date.now();

    const parsedMessage = JSON.parse(message);

    const result = {
      num: count,
      timeSinceStartSeconds: (currTime - (startTime as number)) / 1000,
      // timeSinceStartMs: currTime - (startTime as number),
      isFinal: parsedMessage.is_final,
      speechFinal: parsedMessage.speech_final,
      transcript: parsedMessage.channel.alternatives[0].transcript,
      cursorStartSeconds: parsedMessage.start,
      cursorEndSeconds: parsedMessage.start + parsedMessage.duration,
      // result: parsedMessage,
    };

    console.log("Result", result);

    count += 1;
  });

  // Read audio file
  const data = fs.readFileSync(path.join(__dirname, "..", AUDIO_FILE));

  // Here we use WAV library to extract audio data by itself, without WAV file header
  const wav = new WaveFile();
  wav.fromScratch(1, AUDIO_FILE_SAMPLE_RATE, AUDIO_FILE_BIT_RATE, data);
  const dataWithoutHeader = Buffer.from((wav.data as any).samples);

  // Convert the audio to chunks that simulate a stream of audio data from Twilio
  const chunks = createChunks(dataWithoutHeader, CHUNK_BYTES);

  // Log some stuff
  console.log("Stats", {
    totalSizeBytes: dataWithoutHeader.length,
    totalLengthSeconds: dataWithoutHeader.length / AUDIO_FILE_SAMPLE_RATE,
    // totalLengthMs: (dataWithoutHeader.length / AUDIO_FILE_SAMPLE_RATE) * 1000,
    numChunks: chunks.length,
    chunkSizeBytes: chunks[0].length,
    chunkLengthMs: (chunks[0].length / AUDIO_FILE_SAMPLE_RATE) * 1000,
  });

  // Wait for websocket connection to be ready
  while (transcriber.getReadyState() !== 1) {
    console.log("Waiting for websocket connection");
    await resolveAfter(10);
  }

  // Set time to initial value right before sending chunks
  console.log("Setting start time");
  startTime = Date.now();

  // Send chunks
  for (let i = 0; i < chunks.length; i += 1) {
    transcriber.send(chunks[i]);
    await resolveAfter(25);
  }

  // Wait a bit so that we get all Deepgram transcripts
  await resolveAfter(1000);

  // Clean up connection
  console.log("Destroying connection");
  transcriber.send(JSON.stringify({ type: "CloseStream" }));
  transcriber.removeAllListeners();
};

main();
