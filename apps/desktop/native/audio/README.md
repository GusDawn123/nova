# nova_audio — the AudioCapture native addon (chunk 2)

Two labelled wire-format PCM streams — `me` (mic) and `them` (system audio via
WASAPI loopback, both default-output roles) — delivered to JS through Node-API.
Design: `src/core/` is portable, OS-free C++ (gap filling, framing, mixing,
thread hand-off); `src/win/` is a thin WASAPI shell around it; `src/mac/` is
the signature-complete stub the spec requires.

## Build (Windows)

```
npm run build:native --workspace apps/desktop
```

Produces `build/Release/nova_audio.node`. Needs CMake + Visual Studio C++
tools (cmake-js finds them itself).

## Analysis loop (cpp-analysis MCP server)

The core is deliberately buildable on Linux so every tool can reach it:

- `static_check_file` (clang-tidy / thread-safety) on any file under `src/core/` or `test/`
- `sanitize_project` on this directory, target `core_checks` — asan, tsan, ubsan, lsan
- `profile_project` on this directory, target `core_bench`

`core_checks` is also a plain correctness harness: it exits 1 on any failure.

## Proof recording (the chunk's acceptance test)

```
node tools/record-proof.mjs 30
```

While it runs, speak (→ `me`) and play far-end audio (→ `them`). Wear
headphones — there is no echo cancellation in v1, open speakers leak the far
end into the mic. WAVs land in `.tmp/` here.
