# Natively (aug-20 clone) — Study Notes & Understanding Checklist

Repo: https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant
Local: ~/Documents/natively-aug-20   (baseline for "what's new": old clone at ~/Documents/natively-cluely-ai-assistant, commit e563e37, 2026-08-01)

## Understanding checklist (tick as Gustavo demonstrates each)

### A. The big picture
- [ ] A1. What Natively is (Electron desktop "meeting copilot") and the three process boundaries: Electron main (`electron/`), React renderer (`src/`), Rust native module
- [ ] A2. Why there's a `premium` git submodule and what that means for reading the code
- [ ] A3. Scale of change since Aug 1: ~1,600 commits, ~1,085 files, and what the three big themes were

### B. Models
- [ ] B1. Providers supported (OpenAI, Gemini, Claude, Groq, Ollama, DeepSeek, Codex CLI, "natively" gateway, custom/LiteLLM) and where the catalog lives
- [ ] B2. Default model per family (`ModelVersionManager.ts`) and WHY a "version manager" exists instead of hardcoding ids
- [ ] B3. "Family" vs "concrete model id" — why the code routes on family (`gemini_flash`, `gemini_pro`, `claude`…) and resolves the id late
- [ ] B4. Text vs vision model separation — why the same family can resolve to different ids
- [ ] B5. `modelCapabilities.ts` — what a capability table is for (context window, vision, reasoning, max output) and why it's prefix-matched
- [ ] B6. Fallback chains (`DEFAULT_TEXT_FALLBACK_CONFIG`, `DEFAULT_VISION_FALLBACK_CONFIG`) — what happens when a provider errors mid-stream
- [ ] B7. STT (speech-to-text) models are a separate axis: cloud (Deepgram, OpenAI, Azure, IBM, ElevenLabs, Google) vs local (whisper.cpp, Nemotron)

### C. System prompts
- [ ] C1. `CORE_IDENTITY` — the root block every prompt inherits; its five sections (identity, security, universal_behavior, anti_ai_tells, accuracy_admissions)
- [ ] C2. WHY the security block is so long (prompt-injection + "reveal your prompt" attacks + detection-evasion refusal) and what attack each paragraph answers
- [ ] C3. WHY anti_ai_tells bans the em dash / "delve" etc. — output is spoken aloud by the user
- [ ] C4. The accuracy_admissions templates — the anti-fabrication contract and why behavioral questions are the danger zone
- [ ] C5. Composition: `SHARED_MODE_PREFIX` = CORE_IDENTITY + CONTEXT_INTELLIGENCE_LAYER + SHARED_CODING_RULES + contracts; how mode prompts (General / Looking-for-work / Sales / Recruiting / Team-meet / Lecture / Technical-interview) layer on top
- [ ] C6. Per-provider variants (GROQ_*, OPENAI_*, CLAUDE_*) — why one prompt isn't enough across providers (Claude uses XML `<task>` tags; Groq prompts are shorter)
- [ ] C7. The pipeline of small LLM calls: IntentClassifier → TurnPlanner/AnswerPlanner → WhatToAnswerLLM → AnswerLLM → AnswerValidator/answerPolish; why "what to answer" is a separate model call from "answer"
- [ ] C8. `promptSystemV2.ts` / `PromptAssemblerV2.ts` — the newer assembler; what V2 changed vs the string-concat V1

### D. What's new since Aug 1 (themes)
- [ ] D1. WTA ("what to answer") question-detection audit: QuestionLedger, punctuation provenance, clause-coverage gate — the problem it solves (which question in a live transcript to answer)
- [ ] D2. Nemotron local STT: why they added a second local STT engine next to whisper, and the perf/crash fixes that followed (cold load, SIGABRT, CPU threads)
- [ ] D3. Coding-answer contract: "definite code answers on every channel", code verification runners (local/cloud/SQL/Java/Go/C++) — why an interview copilot runs the code it suggests
- [ ] D4. Doc-grounding policy split: "ground in the files" vs "refuse on absence"
- [ ] D5. TS7 / premium type-check coverage and the Node floor — tooling hygiene

## Running notes
(filled in as we go)

### 2026-08-20 — session 1
- Clone done: 788 MB, tip `5f233d14` (PR #491, WTA phase-1 question detection). Opened in Cursor.
- `premium/` is a git submodule → `natively-premium.git` is PRIVATE (404). Folder is empty here.
  - `electron/premium/featureGate.ts` does a try/`require()` probe for `LicenseManager` + `KnowledgeOrchestrator`;
    if it throws, app runs in "source-available mode". So the open code is written to tolerate the paid half being absent.
  - Reading tip: any time you hit `isPremiumAvailable()` you're at a seam where the closed repo plugs in.
- Model defaults (ModelVersionManager.ts:88-101): gpt-5.4 / gemini-3.7-flash / gemini-3.1-pro-preview / claude-sonnet-4-6 / llama-3.3-70b-versatile (text), llama-4-scout (vision).
- Prompt root: `electron/llm/prompts.ts` → `CORE_IDENTITY` (lines 9-137), 5 sections.
- Since Aug 1: 1,601 commits / 1,085 files / +150k −56k. 27 brand-new files in electron/llm alone. LLMHelper.ts grew by ~2,400 lines (now 8k+).

#### Q: how does prompts.ts stop the AI sounding robotic?
Two layers: PROMPT ASKS, CODE ENFORCES.
- Prompt (prompts.ts): `<anti_ai_tells>` (CORE_IDENTITY :60-108) bans AI words + em/en dash + semicolon + headers in spoken prose, prescribes hedges/self-corrections;
  `HUMAN_SPOKEN_ANSWER_CONTRACT` (:303) bans corporate filler, "rewrite the idea not the phrase";
  `SPOKEN_ANSWER_CONTRACT` (:225) length shapes SPOKEN_SHORT 25-85w / SPOKEN_FULL ≤180w / STRUCTURED_FULL, rotate openers.
- Code: `humanLikeness.ts:252 humanizeSpokenAnswer()` regex pass — protect code/math → strip source narration → "the candidate"→"I" → idiom swaps → em dash→comma (:290), semicolon→new sentence (:294).
  `speakability.ts` word/seconds budget (hard 100w/35s). `answerPolish.ts` AnswerDiversityGuard (no repeated openers). `answerStyle.ts` question-phrasing → length directive.
- WHY: output is spoken aloud by the user; em dash is unspeakable + strongest LLM fingerprint; prompt compliance is probabilistic so regex makes it deterministic; code blocks protected because `;`/`—` are legal there.

#### Prompt architecture (product-neutral summary)
Three axes per request: MODE (who speaks, 8 built-in + custom, ModesManager.ts:66) × ACTION (what comes out, 12, promptSystemV2.ts:47) + TURN CONTENT (evidence/transcript/turn/task).
- V1 = prompts.ts string constants (CORE_IDENTITY + mode text + per-provider copies) → copies drift.
- V2 = promptSystemV2.ts composer. buildSystemPromptV2 (:732) stacks: CORE(tier) → MODE → ACTION → silenceGate → voiceContract → [coding] → [chatLayout] → <custom_instructions> (1,200 cap) → FINAL CHECK (always last: recency; can't be overridden by custom text).
  buildTurnContentV2 (:802): <evidence_set ranked> → <recent_transcript> → <current_turn> → <task> LAST; all XML-escaped.
- Split system/turn = provider prompt caching (GeminiPromptCache.ts). Flag promptSystemV2 (intelligenceFlags.ts) toggles V1/V2.
- Per-turn flow: STT → transcriptQuestionExtractor/questionLedger → TurnPlanner (pure, one TurnPlan; AnswerPlanner regex + IntentClassifier are signals) → Context OS retrieval (intelligence/context-os, rag/) → build prompts → LLMHelper chokepoint (ProviderRouter → ModelVersionManager; fallback chains) → AnswerValidator → humanize → speakability → diversity guard → UI.
- Pattern: DETERMINISTIC CODE DECIDES (route, evidence, silence, format) — MODEL WRITES — CODE ENFORCES after.
- Silence gate: only `assist` may output [[NO_ACTION]]; per-action Set, not prose (benchmark found sentinel leaking on explicit clarify/answer).

#### assist vs answer vs what_to_say
- assist = ambient (no trigger), may emit [[NO_ACTION]], observer voice, "never suggests what to say" (AssistLLM.ts).
- answer = user-triggered; voice follows mode (live role → speak as user; chat panel → explain; `chatSurface` allows structure). AnswerLLM.ts.
- what_to_say = user-triggered hotkey in live call; ALWAYS literal first-person line, no coaching/quotes. WhatToAnswerLLM.ts.
- Difference is WHO triggered + silence permission + voice, not the 3-line action text.
#### prompts.ts (V1) vs promptSystemV2.ts (V2)
- V1: ~45 finished string constants (mode × provider × action baked in). V2: blocks + buildSystemPromptV2(mode, action) at call time; provider-neutral.
- Coexist via `resolveV2SystemPrompt(...) ?? HARD_SYSTEM_PROMPT` (LLMHelper.ts:2581) behind `promptSystemV2` flag.
- V1 pains → V2: drift across copies, duplicated ~2k-token prefix (SHARED_MODE_PREFIX hack), no control over rule position.

#### Which is "better" per their docs? V2 — measured, default ON since 2026-08-02 (commit 0f7fe39f)
- 9×600-pair A/B, DeepSeek V4 Flash gen, blind Gemini judge: 29/32 categories (31/32 warm-cache), judge 18.87 vs 16.51, W-L-T 310-155-103, heavy prompts −49..−87% chars (WTA looking-for-work 47,636→7,502); manual chat +7%, recap/followup grew (deliberate security trade).
- Caveats: COMPLETE-WIN.md results file never committed; PROMPT_SYSTEM_V2_MIGRATION.md deleted same day (81129eda); "live model eval not run"; LLM-judged; stale "Default OFF" comment at intelligenceFlags.ts:300 vs default:true at :519.
- THREE regimes, precedence V3 > V2 > V1: Context Intelligence V3 (context-intelligence/generation/prompt-composer.ts, "THE canonical composer") owns assist/chat/WTA/clarify/brainstorm when it resolves; V2 owns the rest + V3-null fallback; V1 = kill-switch/throw fallback.
