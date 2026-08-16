// Chunk 3's headless proof: the REAL pipeline end to end with no UI in the
// loop — dev sign-in → meeting row → authenticated `/live` socket → stereo
// audio from the real native addon → Deepgram → transcript events printed.
// While it runs, speak (→ me) and/or play speech on the PC (→ them).
//
// Usage: node tools/live-proof.mjs [seconds]   (local dev only; default 20)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const addon = require("../native/audio/build/Release/nova_audio.node");

const seconds = Number(process.argv[2] ?? 20);
const SERVER = "http://127.0.0.1:3000";
const DEV_EMAIL = "dev@nova.test";
const DEV_PASSWORD = "nova-dev-1234"; // the local seed account (supabase/seed.sql)

// The desktop app's own env file carries the local Supabase coordinates.
function readEnv() {
  const text = readFileSync(
    fileURLToPath(new URL("../.env", import.meta.url)),
    "utf8",
  );
  const entries = new Map(
    text
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  const url = entries.get("NOVA_SUPABASE_URL");
  const anonKey = entries.get("NOVA_SUPABASE_ANON_KEY");
  if (url === undefined || anonKey === undefined) {
    throw new Error("apps/desktop/.env is missing the Supabase settings");
  }
  return { url, anonKey };
}

async function signIn(env) {
  const response = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
  });
  if (!response.ok) throw new Error(`sign-in failed (${response.status})`);
  const body = await response.json();
  return { token: body.access_token, userId: body.user.id };
}

async function createMeeting(env, auth) {
  const response = await fetch(`${env.url}/rest/v1/meetings`, {
    method: "POST",
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      user_id: auth.userId,
      title: "live-proof run",
    }),
  });
  if (!response.ok)
    throw new Error(`meeting insert failed (${response.status})`);
  const rows = await response.json();
  return rows[0].id;
}

// Minimal mirror of main's StereoInterleaver, enough for a dev proof.
const FRAME_BYTES = 1920; // one wire batch per channel
const queues = { me: Buffer.alloc(0), them: Buffer.alloc(0) };
function stereoFrames(stream, pcm) {
  queues[stream] = Buffer.concat([queues[stream], pcm]);
  const frames = [];
  while (queues.me.length >= FRAME_BYTES && queues.them.length >= FRAME_BYTES) {
    const out = Buffer.alloc(FRAME_BYTES * 2);
    for (let sample = 0; sample < FRAME_BYTES / 2; sample++) {
      const mono = sample * 2;
      const inter = mono * 2;
      out[inter] = queues.me[mono];
      out[inter + 1] = queues.me[mono + 1];
      out[inter + 2] = queues.them[mono];
      out[inter + 3] = queues.them[mono + 1];
    }
    queues.me = queues.me.subarray(FRAME_BYTES);
    queues.them = queues.them.subarray(FRAME_BYTES);
    frames.push(out);
  }
  return frames;
}

const env = readEnv();
const auth = await signIn(env);
const meetingId = await createMeeting(env, auth);
console.log(`meeting ${meetingId} created; opening /live…`);

const finals = [];
const socket = new WebSocket(`${SERVER.replace("http", "ws")}/live`, {
  headers: { authorization: `Bearer ${auth.token}` },
});

socket.on("open", () => {
  socket.send(
    JSON.stringify({
      v: 1,
      type: "session.start",
      meeting_id: meetingId,
      mode: "general",
      channels: 2,
    }),
  );
});

socket.on("message", (data) => {
  const event = JSON.parse(data.toString("utf8"));
  if (event.type === "session.ready") {
    console.log("session ready — capturing. Speak, or play speech audio.");
    addon.start(
      (batch) => {
        for (const frame of stereoFrames(batch.stream, batch.pcm)) {
          if (socket.readyState === WebSocket.OPEN) socket.send(frame);
        }
      },
      (audioEvent) => {
        console.log(`[audio] ${audioEvent.type}: ${audioEvent.detail}`);
      },
    );
    return;
  }
  if (event.type === "transcript.partial") {
    console.log(`  … [${event.speaker ?? "?"}] ${event.text}`);
    return;
  }
  if (event.type === "transcript.final") {
    console.log(`FINAL [${event.speaker ?? "?"}] ${event.text}`);
    finals.push(event);
    return;
  }
  if (event.type === "error") {
    console.log(`ERROR ${event.code}: ${event.message}`);
    return;
  }
  console.log(`[event] ${event.type}`);
});

socket.on("close", (code) => {
  console.log(`socket closed (${code}); ${finals.length} final line(s).`);
  process.exit(finals.length > 0 ? 0 : 1);
});
socket.on("error", (error) => {
  console.log(`socket error: ${error.message}`);
});

setTimeout(() => {
  console.log("time's up — ending session.");
  socket.send(JSON.stringify({ v: 1, type: "session.end" }));
  addon.stop();
}, seconds * 1000);
