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
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
  // Out-of-range values would be silently clamped to a 1 ms timer by Node,
  // producing empty WAVs that LOOK like a capture failure.
  console.error("usage: node tools/record-proof.mjs [seconds]  (1-3600)");
  process.exit(1);
}
const { sampleRateHz } = addon.wireFormat;
const captured = { me: [], them: [] };

// Live meter state: loudness accumulated per stream since the last print.
const meter = { me: { sum: 0, n: 0 }, them: { sum: 0, n: 0 } };

addon.start(
  (batch) => {
    captured[batch.stream].push(batch.pcm);
    const m = meter[batch.stream];
    for (let i = 0; i < batch.pcm.length; i += 2) {
      const v = batch.pcm.readInt16LE(i);
      m.sum += v * v;
      m.n += 1;
    }
  },
  (event) => {
    console.log(`[${event.type}] ${event.detail}`);
  },
);
console.log(`Recording for ${String(seconds)}s.`);
console.log("Speak for 'me'; play any sound on this PC for 'them'.");
console.log("The bars below move when audio is actually being captured:");

function bar(rms) {
  const filled = Math.min(20, Math.round(rms / 250));
  const level = String(Math.round(rms)).padStart(5);
  return `[${"#".repeat(filled)}${"-".repeat(20 - filled)}]${level}`;
}

let elapsedSeconds = 0;
const meterTimer = setInterval(() => {
  elapsedSeconds += 1;
  const columns = ["me", "them"].map((stream) => {
    const m = meter[stream];
    const rms = m.n === 0 ? 0 : Math.sqrt(m.sum / m.n);
    m.sum = 0;
    m.n = 0;
    return `${stream} ${bar(rms)}`;
  });
  console.log(`${String(elapsedSeconds).padStart(3)}s  ${columns.join("   ")}`);
}, 1000);

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
  clearInterval(meterTimer);
  const { droppedBatches } = addon.stop();
  const outDir = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  for (const stream of ["me", "them"]) {
    const data = Buffer.concat(captured[stream]);
    const file = `${outDir}nova-proof-${stream}.wav`;
    writeFileSync(file, wavFile(data));
    const duration = (data.length / 2 / sampleRateHz).toFixed(1);
    console.log(
      `${stream}: ${duration}s of audio, RMS ${rms(data).toFixed(0)} -> ${file}`,
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
