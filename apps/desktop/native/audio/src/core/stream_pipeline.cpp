#include "stream_pipeline.h"

#include <cassert>
#include <utility>

namespace nova::audio {

StreamPipeline::StreamPipeline(StreamLabel label, int sourceCount)
    : label_(label), mixer_(sourceCount) {
  assert(sourceCount >= 1);
  sources_.reserve(static_cast<size_t>(sourceCount));
  for (int i = 0; i < sourceCount; ++i) {
    sources_.push_back(std::make_unique<Source>());
  }
}

SampleQueue& StreamPipeline::queue(int source) {
  assert(source >= 0 && static_cast<size_t>(source) < sources_.size());
  return sources_[static_cast<size_t>(source)]->queue;
}

void StreamPipeline::setSourceLive(int source, bool live) {
  assert(source >= 0 && static_cast<size_t>(source) < sources_.size());
  // The SAME filler is reconfigured (never replaced): its stream position
  // survives the flip, so a device coming back can't be mistaken for one
  // giant gap since the start of the call.
  sources_[static_cast<size_t>(source)]->filler.setConfig(
      live ? GapFiller::kWireDefaults : GapFiller::kFillEverything);
}

void StreamPipeline::tick(size_t wallSamples, std::vector<FrameBatch>& out) {
  for (size_t i = 0; i < sources_.size(); ++i) {
    Source& source = *sources_[i];
    source.scratch.clear();
    source.queue.drainInto(source.scratch);
    const size_t fill = source.filler.advance(wallSamples, source.scratch.size());
    if (fill > 0) {
      // The gap predates whatever just arrived, so its silence goes first.
      silence_.assign(fill, 0);
      mixer_.push(static_cast<int>(i), silence_.data(), fill);
    }
    mixer_.push(static_cast<int>(i), source.scratch.data(),
                source.scratch.size());
  }

  mixed_.clear();
  mixer_.drainInto(mixed_);
  batches_.clear();
  framer_.push(mixed_.data(), mixed_.size(), batches_);
  for (auto& batch : batches_) {
    out.push_back(FrameBatch{.label = label_, .samples = std::move(batch)});
  }
}

StreamPipeline::Stats StreamPipeline::stats() const {
  Stats stats{.droppedSamples = 0, .injectedSilenceSamples = 0};
  for (const auto& source : sources_) {
    stats.droppedSamples += source->queue.droppedTotal();
    stats.injectedSilenceSamples += source->filler.injectedTotal();
  }
  return stats;
}

}  // namespace nova::audio
