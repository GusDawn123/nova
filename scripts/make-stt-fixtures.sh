#!/usr/bin/env bash
#
# make-stt-fixtures.sh — regenerate the two-speaker STT test fixtures (Phase 3.5).
#
# THE SCRIPT IS THE SOURCE OF TRUTH. The reference transcript and turn boundaries
# in two-speaker-60s.json are computed here (durations via ffprobe, never hand-
# estimated), so regeneration is deterministic modulo the macOS TTS engine.
#
# Requires macOS `say` (two distinct system voices) + `ffmpeg`/`ffprobe`.
# Produces, in apps/server/fixtures/stt/:
#   two-speaker-60s.wav        ~60s, 16kHz mono PCM16, >=6 alternating turns
#   two-speaker-60s.json       { reference_text, turns:[{speaker,start_s,end_s,text}] }
#   two-speaker-60s-noisy.wav  same audio + speakerphone simulation (see FILTER below)
#
# SYNTHETIC-SPEECH CAVEAT: these are TTS voices, not real phone audio. The
# accuracy playbook's 80%/70% word-overlap bars are tuned for human speech; if a
# real vendor underperforms a bar on THIS synthetic audio, the test must report
# the measured number honestly — do NOT silently lower the bar. Bar changes are
# the orchestrator's call (see live.accuracy.test.ts).
#
set -euo pipefail

# --- locations -------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${REPO_ROOT}/apps/server/fixtures/stt"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

mkdir -p "${OUT_DIR}"

# --- tuning ----------------------------------------------------------------
SAMPLE_RATE=16000        # design doc: 16kHz mic feed
GAP_S=0.45               # inter-turn silence (lets endpointing fire, models pauses)
VOICE_A="Samantha"       # Speaker A (customer) — en_US female
VOICE_B="Daniel"         # Speaker B (technician) — en_GB male

# --- conversation (hardcoded → reference text is known by construction) ----
# Home-services HVAC call (Nova's domain). Alternating A/B, 8 turns. No double
# quotes/backslashes in any line (kept JSON-safe for direct embedding).
SPEAKERS=(A B A B A B A B)
TEXTS=(
  "Hi, thank you for calling Nova Heating and Cooling. My air conditioner stopped blowing cold air last night and the house is getting really warm."
  "I am sorry to hear that. Can you tell me whether the outdoor unit is still running, or has it gone completely silent?"
  "The outdoor unit seems to be running just fine, but the air coming from the vents inside is only warm, not cold at all."
  "Understood. That usually points to a refrigerant problem or a frozen coil. Have you noticed any ice building up on the pipes outside?"
  "Now that you mention it, yes, there is a thin layer of ice on one of the copper pipes right next to the unit."
  "That confirms my suspicion. I can schedule a technician to visit you tomorrow morning between eight and ten. Would that time work for you?"
  "Tomorrow morning would be perfect. Thank you so much for your help, I really do appreciate it a great deal."
  "You are very welcome. You are all booked in, and we will send a reminder text this evening. Have a good rest of your day."
)

voice_for() { [ "$1" = "A" ] && echo "${VOICE_A}" || echo "${VOICE_B}"; }

echo "==> generating ${#TEXTS[@]} turns (voices: A=${VOICE_A}, B=${VOICE_B})"

# --- 1. synthesize + normalize each turn, measure duration -----------------
DURATIONS=()
CONCAT_LIST="${WORK_DIR}/concat.txt"
: >"${CONCAT_LIST}"

# One shared silence clip for the inter-turn gaps.
SILENCE_WAV="${WORK_DIR}/silence.wav"
ffmpeg -v error -y -f lavfi -i "anullsrc=r=${SAMPLE_RATE}:cl=mono" \
  -t "${GAP_S}" -c:a pcm_s16le "${SILENCE_WAV}"

for i in "${!TEXTS[@]}"; do
  spk="${SPEAKERS[$i]}"
  voice="$(voice_for "${spk}")"
  raw="${WORK_DIR}/raw_${i}.aiff"
  turn="${WORK_DIR}/turn_${i}.wav"

  say -v "${voice}" -o "${raw}" "${TEXTS[$i]}"
  # Normalize to the mic-feed contract: 16kHz mono signed 16-bit PCM.
  ffmpeg -v error -y -i "${raw}" -ar "${SAMPLE_RATE}" -ac 1 -c:a pcm_s16le "${turn}"

  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${turn}")"
  DURATIONS+=("${dur}")

  echo "file '${turn}'" >>"${CONCAT_LIST}"
  if [ "${i}" -lt "$((${#TEXTS[@]} - 1))" ]; then
    echo "file '${SILENCE_WAV}'" >>"${CONCAT_LIST}"
  fi
done

# --- 2. concatenate to the clean fixture -----------------------------------
CLEAN_WAV="${OUT_DIR}/two-speaker-60s.wav"
ffmpeg -v error -y -f concat -safe 0 -i "${CONCAT_LIST}" \
  -ar "${SAMPLE_RATE}" -ac 1 -c:a pcm_s16le "${CLEAN_WAV}"

# --- 3. build the reference JSON (boundaries from measured durations) ------
JSON="${OUT_DIR}/two-speaker-60s.json"
REFERENCE_TEXT="$(printf '%s ' "${TEXTS[@]}" | sed 's/ *$//')"

# The conversation lines are JSON-safe by construction (no double quotes or
# backslashes — asserted below), so they embed directly into JSON strings.
assert_json_safe() {
  case "$1" in
    *'"'* | *'\'*)
      echo "ERROR: conversation line is not JSON-safe: $1" >&2
      exit 1
      ;;
  esac
}
assert_json_safe "${REFERENCE_TEXT}"

{
  echo "{"
  printf '  "reference_text": "%s",\n' "${REFERENCE_TEXT}"
  printf '  "sample_rate_hz": %s,\n' "${SAMPLE_RATE}"
  echo '  "turns": ['

  offset="0"
  n="${#TEXTS[@]}"
  for i in "${!TEXTS[@]}"; do
    assert_json_safe "${TEXTS[$i]}"
    dur="${DURATIONS[$i]}"
    start="${offset}"
    end="$(awk -v a="${offset}" -v d="${dur}" 'BEGIN{printf "%.3f", a + d}')"
    # Next turn starts after this turn plus the inter-turn gap.
    offset="$(awk -v e="${end}" -v g="${GAP_S}" 'BEGIN{printf "%.3f", e + g}')"

    comma=","
    [ "${i}" -eq "$((n - 1))" ] && comma=""
    printf '    { "speaker": "%s", "start_s": %.3f, "end_s": %.3f, "text": "%s" }%s\n' \
      "${SPEAKERS[$i]}" "${start}" "${end}" "${TEXTS[$i]}" "${comma}"
  done

  echo "  ]"
  echo "}"
} >"${JSON}"

# --- 4. noisy (speakerphone) variant ---------------------------------------
# FILTER chain (documented exactly, order matters):
#   highpass=300 + lowpass=3400  -> telephone/speakerphone passband (300-3400 Hz)
#   aecho=0.8:0.85:70:0.35       -> light room reverb (single 70ms tap)
#   anoisesrc pink + brown, amix -> broadband speakerphone hiss/rumble bed
#   amix voice+noise weights 1 : 0.18 -> ~15 dB SNR (0.18 ~= 10^(-15/20))
#   alimiter + aresample=16000   -> prevent clipping from the sum, keep 16kHz
# NOTE: 0.18 targets ~15 dB SNR by amplitude ratio; it is an approximation, not a
# metrologically exact SNR (real RMS depends on speech/noise crest factors).
NOISY_WAV="${OUT_DIR}/two-speaker-60s-noisy.wav"
CLEAN_DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${CLEAN_WAV}")"
ffmpeg -v error -y -i "${CLEAN_WAV}" -filter_complex "
  [0:a]highpass=f=300,lowpass=f=3400,aecho=0.8:0.85:70:0.35[voice];
  anoisesrc=color=pink:amplitude=0.6:duration=${CLEAN_DUR}[pink];
  anoisesrc=color=brown:amplitude=0.6:duration=${CLEAN_DUR}[brown];
  [pink][brown]amix=inputs=2:normalize=0[noise];
  [voice][noise]amix=inputs=2:weights=1 0.18:normalize=0:duration=first,alimiter,aresample=${SAMPLE_RATE}[out]
" -map "[out]" -ac 1 -c:a pcm_s16le "${NOISY_WAV}"

# --- 5. report -------------------------------------------------------------
probe() {
  ffprobe -v error -show_entries \
    "stream=sample_rate,channels,codec_name:format=duration,size" \
    -of default=noprint_wrappers=1 "$1"
}
echo "==> DONE. Fixtures written to ${OUT_DIR}:"
for f in "${CLEAN_WAV}" "${NOISY_WAV}"; do
  echo "--- $(basename "$f") ---"
  probe "$f"
done
echo "--- $(basename "${JSON}") ---"
head -c 400 "${JSON}"; echo
