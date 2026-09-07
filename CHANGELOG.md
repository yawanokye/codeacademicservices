# Changelog

## 2.9.0 guided human supervisory review

- Reviews a complete thesis one chapter at a time and pauses after each chapter for an explicit user Continue action.
- Saves each chapter report and annotation bundle independently, allowing the supervisor to leave and return later.
- Reuses earlier chapters and the common reference list for alignment in later chapter reviews.
- Assembles a final whole-thesis result after the last chapter and consolidates repeated cross-chapter findings.
- Adds semantic document zones for preliminary pages, TOC, lists, acronyms, main work, references and appendices.
- Applies human-sized comment budgets by review depth and retains grouped lower-priority issues outside margin comments.
- Accepts model-estimated effects for regression-class analyses, SEM, PLS-SEM, mediation and moderation while checking explicit causal claims separately.
- Adds guided workflow state, continuation API, portal actions and durable migration columns.

## 2.8.1 bounded final-audit recovery

- Caps paid final-audit batches for chapters, chapter ranges and complete theses.
- Routes final comment verification directly to GPT-5.6 Terra with degree-calibrated reasoning.
- Splits only a truncated audit batch into smaller focused retries and prevents full-batch fallback loops.
- Prioritises statistical, validity, methods and other high-risk findings when the bounded audit is selected.
- Advances visible progress during checkpointed audit batches instead of leaving active work at 68 percent.
- Preserves lower-risk findings through deterministic evidence gates when they are outside the paid audit cap.

## 2.8.0 long-thesis architecture update

- Routes cleaning and routine coverage to GPT-5.6 Luna at low or medium effort.
- Routes high-risk research sections, final synthesis and external adjudication selectively to GPT-5.6 Terra.
- Runs high-effort Responses API requests in background mode with bounded polling.
- Adds stable prompt-cache keys for repeated system instructions and schemas.
- Removes the browser's false two-hour terminal failure and keeps reconnecting to durable jobs.
- Increases bounded packet concurrency and reduces large coverage packets to 24,000 characters.
- Supports two independent thesis jobs per worker without selecting the same queued job twice.
- Adds optional S3-compatible storage for uploads, checkpoints and generated documents, with PostgreSQL fallback.
- Streams upload reads in bounded chunks and expands the recoverable AI stage to six hours.

## 2.8.0

- Suppresses non-actionable confirmations such as “no action needed” from the numbered correction register.
- Rejects heading-only section-boundary claims when the document structure contradicts them.
- Consolidates repeated background, problem-gap, significance, construct and scope findings before numbering.
- Removes unrelated cross-section instructions accidentally spliced into student-facing actions.
- Calibrates severity so contextual and presentation weaknesses are not labelled Critical without a validity-blocking reason.
- Preserves exact study-specific diagnoses while replacing only generic or excessively long assessments and actions.
- Uses concise natural supervisory comments, retaining issue labels only where they add essential alignment, validity, citation or editorial scope.
- Prefers substantive paragraph evidence over section headings for annotation anchoring.
- Ranks alignment, validity, ethics, methodology and analytical defects ahead of contextual and editorial matters in priority summaries.
- Changes native and inline export checkpoint identifiers so retained jobs can regenerate quality-gated annotations without another provider call.


## 2.7.4
- Added lossless inline-annotation reconciliation for canonical findings omitted during grouped export.
- Preserves completed academic checkpoints and retries only the DOCX export stage.
- Clean deployment package removes historical reports, duplicate legacy modules, test files and obsolete environment examples.

## 2.7.1
- Generates native and inline annotated DOCX files as one atomic delivery bundle.
- Validates current V-Professor comments separately from comments already present in the uploaded source.
- Persists inline annotated documents in file or database-backed artifact storage.
- Blocks completion when any final finding number is absent from either annotated output.
- Prevents the supervisory report from claiming annotations were attached when artifact validation failed.
- Keeps annotated download buttons available when the saved source permits safe regeneration.
- Prevents final presentation filters from silently dropping a canonical finding whose quoted source fragment ends near a citation boundary.
- Retries document-export failures from saved academic checkpoints instead of describing the retry as a new paid expert pass.
- Verified recovery against a DOCX containing existing source comments: all final finding numbers were represented in both native and inline outputs.


## 2.7.0

- Added exact substantive-paragraph anchoring ahead of section-heading anchoring.
- Limited student-facing native comments to focused natural prose of no more than three complete sentences.
- Consolidated overlapping construct-definition, background-progression, problem-gap and scope findings before numbering.
- Added strict canonical-ledger to native-comment reconciliation and blocked inconsistent exports.
- Removed empty source comments and added cautious addressed-status labelling for visibly restored sections.
- Added generic limitations-consequence and unsupported-absolute-claim audits.
- Preserved evidence-locked deterministic findings during AI consolidation.
- Suppressed weak findings based only on concise organisation-of-study descriptions.
- Added tests preventing benchmark-specific names, locations and constructs from entering production rules.
- Updated pipeline and export checkpoint identifiers to 2.7.0.

## 2.6.1

- Added a controlled one-time administrator password reset using `VPROF_RESET_ADMIN_PASSWORD_ON_STARTUP=true`.
- Added explicit startup diagnostics explaining that `ADMIN_PASSWORD` is bootstrap-only when an administrator already exists.
- Added `scripts/reset_admin_password.py` for trusted Render Shell recovery without printing the secret.
- Added administrator environment variables to `render.yaml` and documented the safe reset sequence.
- Added tests preventing silent password overwrite during ordinary restarts.

## 2.6.0
- Final generic release hardening, natural-comment cleanup, mandatory-section evidence gate and duplicate-family consolidation.

# V-Professor 2.5.0

## Current-submission isolation and generic review rules

- Treats every reviewed work and benchmark as job-local evidence rather than a reusable template.
- Removes sample, learned-rule, prior-submission and cross-job context fields before AI calls and final release.
- Adds provider prompt locks against persisting example names, institutions, settings, constructs or weaknesses.
- Replaces sample-specific production rules with generic document-derived setting, population, construct and alignment checks.
- Preserves verified section-contract findings while suppressing heuristic false missing-section and hypothesis findings.
- Consolidates duplicate root causes before numbering and reconciles only current V-Professor comments.
- Labels older source-document comments separately.
- Keeps natural student-facing comments concise and free of mechanical field headings.

## Validation

- 358 automated tests passed from a clean environment.
- Python compilation, JavaScript syntax, Render YAML, duplicate environment-key and secret scans passed.
- Production code contains no names, institutions or locations from the example documents used for quality evaluation.

# V-Professor 2.4.0

## Natural comments and final accuracy control

- Replaced visible comment subsections with connected, natural supervisory prose.
- Grouped all released findings tied to the same paragraph into one numbered native comment.
- Added native-comment reconciliation so every released finding number is represented before export.
- Added whole-section contradiction checks for chapter headings, introductions, objectives, significance and limitations.
- Corrected British/American spelling evidence and removed invented spelling support.
- Added detection of title-purpose claim drift, study-setting drift and modal-verb errors in research questions.
- Consolidated repeated background, problem-gap, significance, terminology and purpose-alignment findings.
- Increased grouped-comment capacity so consolidated actions are not silently truncated.
- Retained provider selection, compact DeepSeek packets and single-target truncation recovery.

## Validation

- 352 automated tests passed.
- The supplied 32-finding benchmark was reduced to 10 distinct, evidence-supported corrections after contradiction filtering and consolidation.

# V-Professor 2.3.2

## DeepSeek length-recovery and cost-control hotfix

- Uses one compact coverage unit per DeepSeek request.
- Limits prose units to three target paragraphs and table units to four rows.
- Uses a compact DeepSeek primary schema with short evidence-grounded actions.
- Does not repeat the same truncated academic packet at a larger budget.
- Splits a truncated unit into one-target recovery requests and merges them into the original canonical coverage record.
- Continues with grounded deterministic findings and an explicit unresolved-coverage flag when an isolated target still cannot be recovered.
- Keeps bounded audit retry behaviour for non-primary audit requests.
- Introduces new checkpoint identifiers so cut-off 2.3.1 responses are not reused.

# V-Professor 2.3.1

## DeepSeek truncation recovery

- Reduced DeepSeek primary review packets to two coverage units, one high-risk unit and 18,000 characters by default.
- Disabled hidden thinking for strict-JSON chapter packets while retaining it for bounded final audits.
- Added one adaptive truncation retry that increases the completion allowance, disables thinking and requests compact schema-compliant JSON.
- Allowed a failed all-DeepSeek first pass to continue into smaller packet recovery instead of stopping immediately.
- Kept non-truncation structured-output failures fail-fast for Light and Standard review to avoid repeated paid full passes.
- Added separate DeepSeek environment controls for primary thinking, audit thinking, output ceiling and packet size.

## Review accuracy

- Added research-design routing for primary quantitative, primary qualitative, mixed-methods, secondary/econometric, experimental and systematic-review studies.
- Added submission-stage gating so Chapters One to Three do not receive results-reporting or moderation-results findings.
- Added whole-section contradiction checks before claiming that background logic, research gaps, professional significance, theory links, population frames, sampling justification, software or chapter organisation are missing.
- Reframed premature moderation-result comments as an objective-framework-method alignment issue.
- Removed questionnaire-study contamination from systematic-review checklists.
- Consolidated repeated purpose-alignment, conceptual-framework, regression-protocol, ethical-access and numerical-source findings using safe anchor or section scopes.
- Reordered native comments so the action required is retained before longer explanatory text.
- Preserved section and table labels in grouped native comments.
- Prevented section-only uploads from generating unsupported whole-chapter population conflicts.

## Provider choice

- Added `VPROF_PRIMARY_PROVIDER=openai|deepseek|auto`.
- Added `VPROF_FALLBACK_PROVIDER=none|openai|deepseek|auto`.
- Added `VPROF_PROVIDER_FAILOVER=true|false`.
- Added DeepSeek V4 Pro and V4 Flash defaults, thinking controls and model-specific cost accounting.
- Explicit provider selection overrides the combined OpenAI pipeline.

## Validation

- 345 automated tests passed from a clean test environment.
- Python compilation passed.
- Provider-selection, wrong-design, wrong-stage, false-positive, exact-anchor grouping and table-reference regression tests passed.
# v2.2.0, final exact-anchor and cost-efficient professional review

## Quality corrections

- Added revision-visible DOCX extraction so tracked insertions can be reviewed instead of silently disappearing from parsed text.
- Added direct detection of unresolved supervisor instructions, incomplete citation fragments, excessive historical background, unnamed single-firm settings and recurring sentence-level errors.
- Corrected chapter detection so an organisation-of-study sentence beginning with “Chapter two…” does not create a false second chapter.
- Strengthened evidence-grounded checks for local problem evidence, research gaps, construct consistency, purpose-objective-question alignment, causal claim strength and limitation-versus-delimitation.
- Added issue-specific completion verification for citations, statistics, language, scope, alignment, causal claims, gaps, constructs and contributions.
- Consolidated only genuine duplicate root causes. Different sentence anchors and different statistical defects remain separate.
- Grouped findings sharing the same exact sentence or paragraph into one numerically ordered native Word comment box.
- Shortened inline comments to the issue and immediate action while retaining full detail in native comments and the appended report.
- Ensured the native, inline and report outputs reuse one final numbered ledger.

## Cost corrections

- Replaced universal second-pass auditing with risk-selected paid auditing.
- Limited Standard chapter review to one compact paid accuracy-audit batch.
- Kept routine and final Standard synthesis on GPT-5.6 Terra.
- Reserved GPT-5.6 Sol for PhD final synthesis, external-examiner adjudication and selective Advanced escalation.
- Reduced routine output-token ceilings and increased safe section batching.
- Retained deterministic evidence, placement and public-language gates for findings that do not require a second paid model call.

## Stability

- Retained bounded truncation recovery without falsely disabling the OpenAI provider.
- Updated pipeline and checkpoint identifiers to prevent reuse of incomplete earlier-stage outputs.
- Added final release regression tests for tracked text, chapter detection, known Chapter One defects, canonical numbering, exact-anchor grouping, concise inline annotations and cost-aware routing.

# v2.1.1, provider recovery and audit stability hotfix

- Fixed the `submission_scope` interface mismatch that crashed deterministic expert checks.
- Prevented output truncation and schema errors from opening the provider circuit.
- Split comment-accuracy audits into token-safe batches.

# v2.1.0, evidence-grounded professional supervisory review

- Introduced the canonical evidence ledger, scope-aware review rules and exact source anchoring.
- Added positive grounding validation and ArticleReady-style action reporting.

## 2.7.2

- Fixed loss of canonical finding numbers during grouped native-comment export.
- Added non-lossy final reconciliation comments for unrepresented findings.
- Added export-stage-specific recovery guidance that does not request API-key checks.
