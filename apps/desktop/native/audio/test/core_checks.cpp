// The sanitizers' meal: exercises every core component end to end, including
// the one real concurrency surface (SampleQueue) under genuine thread
// contention in the exact shape production uses (capture threads pushing
// while the engine thread ticks). Run under asan/tsan/ubsan/lsan via the
// cpp-analysis MCP server; also a plain correctness check (exit 1 on failure).
#include <cstdint>
#include <cstdio>
#include <thread>
#include <vector>

#include "core/framer.h"
#include "core/gap_filler.h"
#include "core/sample_queue.h"
#include "core/stream.h"
#include "core/stream_mixer.h"
#include "core/stream_pipeline.h"
#include "core/wire.h"

namespace {

using namespace nova::audio;

int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAILED: %s (%s:%d)\n", #cond, __FILE__, __LINE__);   \
      ++failures;                                                       \
    }                                                                   \
  } while (0)

void framerRegroupsAnySliceIntoExactBatches() {
  Framer framer;
  std::vector<std::vector<int16_t>> batches;

  // 5 full batches plus a ragged tail, pushed in awkward chunk sizes.
  const size_t total = 5 * wire::kBatchSamples + 123;
  std::vector<int16_t> input(total);
  for (size_t i = 0; i < total; ++i) {
    input[i] = static_cast<int16_t>(i % 30000);
  }
  const size_t chunkSizes[] = {1, 7, 320, 333, 960, 961};
  size_t offset = 0;
  size_t chunkIndex = 0;
  while (offset < total) {
    size_t take = chunkSizes[chunkIndex % 6];
    if (take > total - offset) {
      take = total - offset;
    }
    framer.push(input.data() + offset, take, batches);
    offset += take;
    ++chunkIndex;
  }

  CHECK(batches.size() == 5);
  size_t position = 0;
  for (const auto& batch : batches) {
    CHECK(batch.size() == static_cast<size_t>(wire::kBatchSamples));
    for (const int16_t sample : batch) {
      CHECK(sample == static_cast<int16_t>(position % 30000));
      ++position;
    }
  }

  // Topping the tail up to a boundary yields exactly one more batch.
  std::vector<int16_t> top(wire::kBatchSamples - 123, 0);
  framer.push(top.data(), top.size(), batches);
  CHECK(batches.size() == 6);
}

void gapFillerStaysQuietUnderJitter() {
  GapFiller filler;
  size_t wall = 0;
  size_t injected = 0;
  // Delivery alternates late/catch-up — the healthy jitter shape. Deficit
  // never exceeds one 640-sample swing, far under the 3200 tolerance.
  for (int tick = 0; tick < 1000; ++tick) {
    wall += wire::kFrameSamples;
    const size_t arrived = (tick % 2 == 0) ? 0 : 2 * wire::kFrameSamples;
    injected += filler.advance(wall, arrived);
  }
  CHECK(injected == 0);
}

void gapFillerBackfillsARealGap() {
  GapFiller filler;
  size_t wall = 0;
  // Healthy stretch: arrivals match the wall exactly.
  for (int tick = 0; tick < 50; ++tick) {
    wall += wire::kFrameSamples;
    CHECK(filler.advance(wall, wire::kFrameSamples) == 0);
  }
  // Dead air: 50 ticks (16000 samples) of nothing.
  size_t injected = 0;
  for (int tick = 0; tick < 50; ++tick) {
    wall += wire::kFrameSamples;
    injected += filler.advance(wall, 0);
  }
  // The hole is repaired up to the hysteresis band: deficit left in
  // [refill target, tolerance], everything else backfilled.
  const size_t deficit = 16000 - injected;
  CHECK(deficit >= GapFiller::kWireDefaults.refillTargetSamples);
  CHECK(deficit <= GapFiller::kWireDefaults.toleranceSamples);
  // Resumed delivery must not trigger another fill (no oscillation).
  for (int tick = 0; tick < 50; ++tick) {
    wall += wire::kFrameSamples;
    CHECK(filler.advance(wall, wire::kFrameSamples) == 0);
  }
}

void gapFillerFillsEverythingForDeadSources() {
  GapFiller filler(GapFiller::kFillEverything);
  size_t wall = 0;
  for (int tick = 0; tick < 100; ++tick) {
    wall += wire::kFrameSamples;
    CHECK(filler.advance(wall, 0) ==
          static_cast<size_t>(wire::kFrameSamples));
  }
}

void sampleQueueDropsIncomingWhenFullAndCounts() {
  SampleQueue queue(100);
  std::vector<int16_t> chunk(160, 42);
  CHECK(queue.push(chunk.data(), chunk.size()) == 60);
  CHECK(queue.droppedTotal() == 60);
  std::vector<int16_t> out;
  CHECK(queue.drainInto(out) == 100);
  CHECK(queue.push(chunk.data(), chunk.size()) == 60);  // refills after drain
}

void sampleQueueSurvivesConcurrentPushers() {
  SampleQueue queue;
  const size_t chunks = 1000;
  const size_t chunkSamples = 160;

  auto producer = [&queue](int16_t marker) {
    const std::vector<int16_t> chunk(chunkSamples, marker);
    for (size_t i = 0; i < chunks; ++i) {
      queue.push(chunk.data(), chunk.size());
    }
  };
  std::thread producerA(producer, 1111);
  std::thread producerB(producer, 2222);

  // The consumer drains concurrently, like the engine tick does.
  std::vector<int16_t> drained;
  while (drained.size() + queue.droppedTotal() < 2 * chunks * chunkSamples) {
    queue.drainInto(drained);
  }
  producerA.join();
  producerB.join();
  queue.drainInto(drained);

  CHECK(drained.size() + queue.droppedTotal() == 2 * chunks * chunkSamples);
  for (const int16_t sample : drained) {
    CHECK(sample == 1111 || sample == 2222);
  }
}

void mixerPassesThroughASingleSource() {
  StreamMixer mixer(1);
  const std::vector<int16_t> input{1, -2, 3, -4, 5};
  mixer.push(0, input.data(), input.size());
  std::vector<int16_t> out;
  CHECK(mixer.drainInto(out) == input.size());
  CHECK(out == input);
}

void mixerSaturatesInsteadOfWrapping() {
  StreamMixer mixer(2);
  const std::vector<int16_t> loudA{30000, -30000, 100};
  const std::vector<int16_t> loudB{30000, -30000, 23};
  mixer.push(0, loudA.data(), loudA.size());
  mixer.push(1, loudB.data(), loudB.size());
  std::vector<int16_t> out;
  CHECK(mixer.drainInto(out) == 3);
  CHECK(out.size() == 3 && out[0] == 32767 && out[1] == -32768 &&
        out[2] == 123);
}

void mixerWaitsForTheSlowerSource() {
  StreamMixer mixer(2);
  const std::vector<int16_t> ones(100, 1);
  const std::vector<int16_t> twos(60, 2);
  mixer.push(0, ones.data(), ones.size());
  mixer.push(1, twos.data(), twos.size());
  std::vector<int16_t> out;
  CHECK(mixer.drainInto(out) == 60);  // only what BOTH sources delivered
  CHECK(out.back() == 3);
  mixer.push(1, twos.data(), 40);
  CHECK(mixer.drainInto(out) == 40);  // the carried-over 40 ones now mix
  CHECK(out.size() == 100 && out.back() == 3);
}

void pipelineMixesALiveSourceAgainstADeadSlot() {
  // The production "them" topology when both render roles share a device:
  // source 0 live, source 1 permanently dead (pure gap-filled silence).
  StreamPipeline them(StreamLabel::Them, 2);
  them.setSourceLive(1, false);

  const std::vector<int16_t> tone(wire::kFrameSamples, 777);
  std::vector<FrameBatch> batches;
  size_t wall = 0;
  for (int tick = 0; tick < 99; ++tick) {
    wall += wire::kFrameSamples;
    them.queue(0).push(tone.data(), tone.size());
    them.tick(wall, batches);
  }

  // 99 frames = 33 exact batches, all labelled, all still 777 — the dead
  // slot's silence must mix as a no-op.
  CHECK(batches.size() == 33);
  for (const auto& batch : batches) {
    CHECK(batch.label == StreamLabel::Them);
    CHECK(batch.samples.size() == static_cast<size_t>(wire::kBatchSamples));
    for (const int16_t sample : batch.samples) {
      CHECK(sample == 777);
    }
  }
}

void pipelineKeepsTheTimelineAcrossADeadSpell() {
  StreamPipeline me(StreamLabel::Me, 1);
  const std::vector<int16_t> before(wire::kFrameSamples, 1000);
  const std::vector<int16_t> after(wire::kFrameSamples, 2000);
  std::vector<FrameBatch> batches;
  size_t wall = 0;

  for (int tick = 0; tick < 50; ++tick) {
    wall += wire::kFrameSamples;
    me.queue(0).push(before.data(), before.size());
    me.tick(wall, batches);
  }
  for (int tick = 0; tick < 200; ++tick) {  // mic goes quiet, wall marches on
    wall += wire::kFrameSamples;
    me.tick(wall, batches);
  }
  for (int tick = 0; tick < 50; ++tick) {
    wall += wire::kFrameSamples;
    me.queue(0).push(after.data(), after.size());
    me.tick(wall, batches);
  }

  // The emitted timeline must hold ~all 300 frames' worth of samples: real
  // audio plus explicit silence, minus at most the hysteresis band and one
  // partial batch still pending.
  size_t emitted = 0;
  for (const auto& batch : batches) {
    emitted += batch.samples.size();
  }
  CHECK(emitted + GapFiller::kWireDefaults.toleranceSamples +
            wire::kBatchSamples >=
        wall);
  CHECK(emitted <= wall);

  // And in order: all the 1000s, then silence, then the 2000s.
  std::vector<int16_t> flat;
  for (const auto& batch : batches) {
    flat.insert(flat.end(), batch.samples.begin(), batch.samples.end());
  }
  size_t last1000 = 0;
  size_t first2000 = flat.size();
  size_t zeros = 0;
  for (size_t i = 0; i < flat.size(); ++i) {
    if (flat[i] == 1000) {
      last1000 = i;
    } else if (flat[i] == 2000 && first2000 == flat.size()) {
      first2000 = i;
    } else if (flat[i] == 0) {
      ++zeros;
    }
  }
  CHECK(last1000 < first2000);
  CHECK(zeros >= 200 * static_cast<size_t>(wire::kFrameSamples) -
                     GapFiller::kWireDefaults.toleranceSamples -
                     static_cast<size_t>(wire::kBatchSamples));
}

void pipelineSurvivesConcurrentPushAndTick() {
  // The real thread shape: a capture thread pushes while the engine ticks.
  StreamPipeline me(StreamLabel::Me, 1);
  const size_t ticks = 500;

  std::thread capture([&me] {
    const std::vector<int16_t> tone(wire::kFrameSamples, 7);
    for (size_t i = 0; i < ticks; ++i) {
      me.queue(0).push(tone.data(), tone.size());
    }
  });

  std::vector<FrameBatch> batches;
  size_t wall = 0;
  for (size_t i = 0; i < ticks; ++i) {
    wall += wire::kFrameSamples;
    me.tick(wall, batches);
  }
  capture.join();
  me.tick(wall, batches);  // final drain

  size_t emitted = 0;
  for (const auto& batch : batches) {
    emitted += batch.samples.size();
    for (const int16_t sample : batch.samples) {
      CHECK(sample == 7 || sample == 0);
    }
  }
  // Conservation against what ACTUALLY flowed, not against the synthetic
  // wall: if the pusher lags the ticker, the filler injects silence AND the
  // late real samples still arrive, so output can legitimately exceed the
  // wall. What must hold exactly: everything kept or injected came out,
  // minus at most one partial batch pending in the framer.
  const StreamPipeline::Stats stats = me.stats();
  const size_t available = ticks * static_cast<size_t>(wire::kFrameSamples) -
                           stats.droppedSamples +
                           stats.injectedSilenceSamples;
  CHECK(emitted <= available);
  CHECK(emitted + wire::kBatchSamples > available);
  // And the stream never fell behind the wall by more than the hysteresis
  // band plus one pending batch — the gap filler's whole job.
  CHECK(emitted + GapFiller::kWireDefaults.toleranceSamples +
            wire::kBatchSamples >=
        wall);
}

}  // namespace

int main() {
  framerRegroupsAnySliceIntoExactBatches();
  gapFillerStaysQuietUnderJitter();
  gapFillerBackfillsARealGap();
  gapFillerFillsEverythingForDeadSources();
  sampleQueueDropsIncomingWhenFullAndCounts();
  sampleQueueSurvivesConcurrentPushers();
  mixerPassesThroughASingleSource();
  mixerSaturatesInsteadOfWrapping();
  mixerWaitsForTheSlowerSource();
  pipelineMixesALiveSourceAgainstADeadSlot();
  pipelineKeepsTheTimelineAcrossADeadSpell();
  pipelineSurvivesConcurrentPushAndTick();

  if (failures == 0) {
    std::printf("core_checks: all scenarios passed\n");
    return 0;
  }
  std::printf("core_checks: %d check(s) FAILED\n", failures);
  return 1;
}
