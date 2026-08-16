#include "sample_queue.h"

#include <algorithm>

namespace nova::audio {

SampleQueue::SampleQueue(size_t maxSamples) : maxSamples_(maxSamples) {}

size_t SampleQueue::push(const int16_t* samples, size_t count) {
  const std::scoped_lock lock(mutex_);
  const size_t room =
      buffer_.size() >= maxSamples_ ? 0 : maxSamples_ - buffer_.size();
  const size_t take = std::min(count, room);
  buffer_.insert(buffer_.end(), samples, samples + take);
  const size_t dropped = count - take;
  dropped_ += dropped;
  return dropped;
}

size_t SampleQueue::drainInto(std::vector<int16_t>& out) {
  const std::scoped_lock lock(mutex_);
  out.insert(out.end(), buffer_.begin(), buffer_.end());
  const size_t drained = buffer_.size();
  // clear() keeps the vector's capacity, so steady-state operation stops
  // allocating entirely once the buffer has seen its high-water mark.
  buffer_.clear();
  return drained;
}

size_t SampleQueue::droppedTotal() const {
  const std::scoped_lock lock(mutex_);
  return dropped_;
}

}  // namespace nova::audio
