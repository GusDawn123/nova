#pragma once

#include <cstdint>
#include <vector>

namespace nova::audio {

// The two labelled streams (§5 ratified decision 3): the near end is the mic,
// the far end is whatever the machine plays. There is no diarization in the
// 2-person case — these labels ARE the speaker attribution.
enum class StreamLabel { Me, Them };

inline constexpr const char* toString(StreamLabel label) {
  return label == StreamLabel::Me ? "me" : "them";
}

// One delivery to the embedder: wire::kBatchSamples of wire-format PCM.
struct FrameBatch {
  StreamLabel label;
  std::vector<int16_t> samples;
};

}  // namespace nova::audio
