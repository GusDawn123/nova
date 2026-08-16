# nova_audio — the AudioCapture native addon (chunk 2).
#
# One CMakeLists, two personalities:
#   • cmake-js (from apps/desktop) builds the Node-API addon for the platform.
#   • a plain `cmake` configure — which is what the cpp-analysis MCP server
#     does, on Linux — builds the analysis harnesses instead. That split is
#     deliberate: everything that CAN live in the portable core does, so the
#     sanitizers, clang-tidy and the profiler can actually reach it.
cmake_minimum_required(VERSION 3.21)
project(nova_audio CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── the portable core: no OS headers, no Node headers ──────────────────────
add_library(nova_audio_core STATIC
  src/core/framer.cpp
  src/core/gap_filler.cpp
  src/core/sample_queue.cpp
  src/core/stream_mixer.cpp
  src/core/stream_pipeline.cpp
)
target_include_directories(nova_audio_core PUBLIC src)
if(MSVC)
  target_compile_options(nova_audio_core PUBLIC /W4)
else()
  target_compile_options(nova_audio_core PUBLIC -Wall -Wextra)
  find_package(Threads REQUIRED)
  target_link_libraries(nova_audio_core PUBLIC Threads::Threads)
endif()

if(CMAKE_JS_VERSION)
  # ── the Node-API addon (cmake-js drives this branch) ──────────────────────
  execute_process(
    COMMAND node -p "require('node-addon-api').include_dir"
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )

  add_library(${PROJECT_NAME} SHARED src/binding.cpp ${CMAKE_JS_SRC})
  set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
  target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_JS_INC}
    ${NODE_ADDON_API_DIR}
  )
  # NAPI 8 is available in every Node/Electron we would ship (§5.1: Node-API
  # is the ratified choice precisely for this ABI stability).
  target_compile_definitions(${PROJECT_NAME} PRIVATE
    NAPI_VERSION=8
    NAPI_CPP_EXCEPTIONS
  )
  target_link_libraries(${PROJECT_NAME} PRIVATE nova_audio_core ${CMAKE_JS_LIB})

  if(WIN32)
    target_sources(${PROJECT_NAME} PRIVATE
      src/win/wasapi_capture.cpp
      src/win/wasapi_session.cpp
    )
    # windows.h without NOMINMAX poisons std::min/max; LEAN_AND_MEAN keeps
    # the include surface (and build time) down.
    target_compile_definitions(${PROJECT_NAME} PRIVATE
      NOMINMAX
      WIN32_LEAN_AND_MEAN
    )
    target_link_libraries(${PROJECT_NAME} PRIVATE ole32)  # COM
  elseif(APPLE)
    target_sources(${PROJECT_NAME} PRIVATE src/mac/audio_capture_mac.cpp)
  endif()
else()
  # ── analysis harnesses (no cmake-js in sight = a tooling build) ───────────
  # core_checks is the sanitizers' meal: asan/tsan/ubsan/lsan build and RUN it
  # end to end. core_bench gives the profiler a sustained workload to rank.
  add_executable(core_checks test/core_checks.cpp)
  target_link_libraries(core_checks PRIVATE nova_audio_core)

  add_executable(core_bench test/core_bench.cpp)
  target_link_libraries(core_bench PRIVATE nova_audio_core)
endif()
