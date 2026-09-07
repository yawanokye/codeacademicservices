# V-Professor v2.8.1 Deployment Guide

## Architecture

Deploy three Render resources:

1. PostgreSQL database: `vprofessor-db`
2. Web service: `vprofessor-web`
3. Background worker: `vprofessor-worker`

The included `render.yaml` creates the resources and shares one environment definition between the web service and worker.

## Commands

Web service:

```text
Build: python -m pip install -r requirements.txt
Start: uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Background worker:

```text
Build: python -m pip install -r requirements.txt
Start: python -m app.worker
```

## Required secrets

Set the following in Render without committing their real values:

```env
DATABASE_URL=<shared PostgreSQL connection>
SESSION_SECRET=<strong random value>
OPENAI_API_KEY=<secret>        # when OpenAI is enabled
DEEPSEEK_API_KEY=<secret>      # when DeepSeek is enabled
ADMIN_PASSWORD=<strong password>
```

The web service and worker must use the same database and provider settings.

## Final review controls

Keep these enabled on both services:

```env
VPROF_NATIVE_COMMENT_STYLE=exact_anchor_grouped
VPROF_EXISTING_COMMENT_POLICY=label
VPROF_STRICT_NATIVE_RECONCILIATION=true
VPROF_GROUP_SAME_ANCHOR_COMMENTS=true
VPROF_HUMAN_ROOT_CAUSE_CONSOLIDATION=true
VPROF_LIMITATIONS_CONSEQUENCE_AUDIT=true
VPROF_ABSOLUTE_CLAIM_AUDIT=true
VPROF_EXPORT_ANCHOR_RECONCILIATION=true
```

Native and inline reconciliation stops completion rather than releasing a report-only result. Current V-Professor comments are counted separately from comments inherited from the uploaded source, and every canonical finding number must appear in both annotated outputs. Findings tied to the same exact paragraph may share one comment box while retaining their individual numbers.

Keep `VPROF_DB_ARTIFACT_STORAGE=true` during migration. If `S3_BUCKET` is set, the app stores large uploads, checkpoints and generated files in the configured S3-compatible bucket and uses PostgreSQL only as the compatibility fallback.

Recommended durable object-storage settings:

```env
VPROF_ARTIFACT_STORAGE_BACKEND=auto
S3_BUCKET=<bucket-name>
S3_ENDPOINT_URL=<provider-endpoint>
S3_REGION=<region>
S3_ACCESS_KEY_ID=<secret>
S3_SECRET_ACCESS_KEY=<secret>
S3_PREFIX=vprofessor
S3_SERVER_SIDE_ENCRYPTION=AES256
```

Previous source-document comments remain separate from current V-Professor findings. Empty comments are removed, and an obvious missing-section comment may be marked as addressed when the section is visibly present in the current file.

## Provider selection

### DeepSeek

```env
VPROF_PRIMARY_PROVIDER=deepseek
VPROF_ENABLE_DEEPSEEK=true
VPROF_ENABLE_OPENAI=false
DEEPSEEK_API_KEY=<secret>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_REVIEW_MODEL=deepseek-v4-pro
DEEPSEEK_ADVANCED_MODEL=deepseek-v4-pro
DEEPSEEK_QUALITY_MODEL=deepseek-v4-pro
DEEPSEEK_FAST_MODEL=deepseek-v4-flash
DEEPSEEK_PRIMARY_THINKING_ENABLED=false
DEEPSEEK_AUDIT_THINKING_ENABLED=true
DEEPSEEK_TRUNCATION_RECOVERY=true
DEEPSEEK_COVERAGE_UNITS_PER_REQUEST=1
DEEPSEEK_COVERAGE_HIGH_RISK_UNITS_PER_REQUEST=1
VPROF_PROVIDER_FAILOVER=false
VPROF_FALLBACK_PROVIDER=none
```

### OpenAI

```env
VPROF_PRIMARY_PROVIDER=openai
VPROF_ENABLE_OPENAI=true
VPROF_ENABLE_DEEPSEEK=false
OPENAI_API_KEY=<secret>
OPENAI_FAST_MODEL=gpt-5.6-luna
OPENAI_CLEANING_MODEL=gpt-5.6-luna
OPENAI_CHAPTER_MODEL=gpt-5.6-luna
OPENAI_SECTION_ANALYSIS_MODEL=gpt-5.6-luna
OPENAI_EXPERT_MODEL=gpt-5.6-terra
OPENAI_FINAL_AUDIT_MODEL=gpt-5.6-terra
OPENAI_FINAL_SYNTHESIS_MODEL=gpt-5.6-terra
OPENAI_PHD_FINAL_SYNTHESIS_MODEL=gpt-5.6-terra
OPENAI_EXTERNAL_DOMAIN_MODEL=gpt-5.6-terra
OPENAI_EXTERNAL_ADJUDICATOR_MODEL=gpt-5.6-terra
OPENAI_CLEANING_REASONING_EFFORT=low
OPENAI_SECTION_ANALYSIS_REASONING_EFFORT=medium
OPENAI_CHAPTER_REASONING_EFFORT=medium
OPENAI_EXPERT_REASONING_EFFORT=high
OPENAI_FINAL_AUDIT_REASONING_EFFORT=xhigh
OPENAI_NON_RESEARCH_MASTERS_AUDIT_REASONING_EFFORT=medium
OPENAI_RESEARCH_MASTERS_AUDIT_REASONING_EFFORT=high
OPENAI_PROFESSIONAL_DOCTORATE_AUDIT_REASONING_EFFORT=high
OPENAI_PHD_AUDIT_REASONING_EFFORT=xhigh
OPENAI_PHD_FINAL_SYNTHESIS_REASONING_EFFORT=xhigh
OPENAI_EXTERNAL_DOMAIN_REASONING_EFFORT=high
OPENAI_EXTERNAL_ADJUDICATOR_REASONING_EFFORT=xhigh
OPENAI_BACKGROUND_MODE=true
OPENAI_BACKGROUND_POLL_SECONDS=5
OPENAI_BACKGROUND_TIMEOUT_SECONDS=3600
OPENAI_PROMPT_CACHE_ENABLED=true
VPROF_PROVIDER_FAILOVER=false
VPROF_FALLBACK_PROVIDER=none
```

## Administrator bootstrap and recovery

The first administrator is created from `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Normal restarts do not overwrite an administrator already stored in PostgreSQL.

For a controlled one-time reset:

```env
VPROF_RESET_ADMIN_PASSWORD_ON_STARTUP=true
```

Redeploy the web service, sign in with the configured credentials, then immediately return the flag to `false` and redeploy. The password is never printed in the startup logs. A trusted Render Shell may alternatively run:

```bash
python scripts/reset_admin_password.py
```

## Deployment sequence

1. Allow active jobs to finish or pause them deliberately.
2. Deploy the 2.8.1 code to both the web service and worker.
3. Confirm the shared database, `VPROF_DB_ARTIFACT_STORAGE=true` and selected provider key are available to both services.
4. Confirm the web health check and worker startup logs are successful.
5. Open an existing retained result and test both annotated downloads. They should regenerate from the saved source without repeating the academic AI pass.
6. For a paused or failed document-export job, select **Recover** once. The completed academic-review checkpoints are retained and only the annotation bundle is rebuilt.
7. Submit a short new review job and confirm that completion occurs only after the native annotated DOCX, inline annotated DOCX and supervisory report are available.
8. Verify that every released finding number appears in both annotated outputs.
9. Submit a 120-page test thesis, close the browser, reopen the portal and confirm that the same job reconnects and resumes from saved packet checkpoints.

Submit a new review only when the original source payload is no longer available.

## Local validation

```bash
rm -f supervisor.db
PYTHONPATH=. pytest -q
python -m compileall -q app scripts
node --check app/static/app.js
```
