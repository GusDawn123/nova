// Chunk 2's proof harness (§6): records the two labelled streams to WAV files
// so a human can verify each contains ONLY its own speaker. The real proof is
// a two-party Zoom call with the meeting routed to the communications device,
// headphones on (§5 decision 4: no AEC in v1 — open speakers leak the far end
// into the mic by design).
//
// Usage:   node tools/record-proof.mjs [seconds]     (default 30; Ctrl+C stops)
// Output:  native/audio/.tmp/nova-proof-{me,them}.wav
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const addon = require("../build/Release/nova_audio.node");

const seconds = Number(process.argv[2] ?? 30);
const { sampleRateHz } = addon.wireFormat;
const captured = { me: [], them: [] };

addon.start(
  (batch) => {
    captured[batch.stream].push(batch.pcm);
  },
  (event) => {
    console.log(`[${event.type}] ${event.detail}`);
  },
);
console.log(
  `Recording for ${String(seconds)}s — speak (me) and play far-end audio (them)…`,
);

function wavFile(data) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// A quick liveness number per stream: silence reads ~0, speech reads hundreds+.
function rms(data) {
  const samples = data.length / 2;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = data.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

function finish() {
  const { droppedBatches } = addon.stop();
  const outDir = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  for (const stream of ["me", "them"]) {
    const data = Buffer.concat(captured[stream]);
    const file = `${outDir}nova-proof-${stream}.wav`;
    writeFileSync(file, wavFile(data));
    const duration = (data.length / 2 / sampleRateHz).toFixed(1);
    console.log(
      `${stream}: ${duration}s of audio, RMS ${rms(data).toFixed(0)} → ${file}`,
    );
  }
  if (droppedBatches > 0) {
    console.log(`WARNING: ${String(droppedBatches)} batches were dropped`);
  }
  process.exit(0);
}

const timer = setTimeout(finish, seconds * 1000);
process.on("SIGINT", () => {
  clearTimeout(timer);
  finish();
});
