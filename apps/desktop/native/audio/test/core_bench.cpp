// The profiler's meal: a sustained, realistic workload — one hour of call
// audio (mic + two live loopback sources) pushed through both pipelines at
// maximum speed. Run via the cpp-analysis MCP server's profile_project to
// rank where core's time actually goes.
#include <cstdint>
#include <cstdio>
#include <vector>

#include "core/stream.h"
#include "core/stream_pipeline.h"
#include "core/wire.h"

int main() {
  using namespace nova::audio;

  StreamPipeline me(StreamLabel::Me, 1);
  StreamPipeline them(StreamLabel::Them, 2);  // both sources live: worst case

  // Deterministic tone-ish content (no randomness: reruns must rank the
  // same code, not different data).
  std::vector<int16_t> tone(wire::kFrameSamples);
  for (size_t i = 0; i < tone.size(); ++i) {
    tone[i] = static_cast<int16_t>((i * 373) % 20000 - 10000);
  }

  const size_t ticks = 180000;  // one hour of 20 ms ticks
  std::vector<FrameBatch> batches;
  size_t wall = 0;
  size_t emittedSamples = 0;
  int64_t checksum = 0;

  for (size_t tick = 0; tick < ticks; ++tick) {
    wall += wire::kFrameSamples;
    me.queue(0).push(tone.data(), tone.size());
    them.queue(0).push(tone.data(), tone.size());
    them.queue(1).push(tone.data(), tone.size());

    batches.clear();
    me.tick(wall, batches);
    them.tick(wall, batches);
    for (const auto& batch : batches) {
      emittedSamples += batch.samples.size();
      checksum += batch.samples.front() + batch.samples.back();
    }
  }

  // Checksum printed so the whole pipeline is observable work the optimizer
  // cannot delete.
  std::printf("core_bench: %zu samples emitted, checksum %lld\n",
              emittedSamples, static_cast<long long>(checksum));
  return emittedSamples > 0 ? 0 : 1;
}
