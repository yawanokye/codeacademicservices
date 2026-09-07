# UCC Submission Portal v8 Patch

Apply this patch on top of `ucc_departmental_submission_portals_v7_resources`.

## Replace these files in the repository

1. `server.js`
2. `public/styles.css`
3. `public/project-work.html`
4. `public/dissertation.html`
5. `public/assessor.html`
6. `admin/admin.js`
7. `admin/admin.css`
8. `admin/index.html`

No new npm dependency and no new Render environment variable is required.

## What this patch changes

### Compact resources on public submission pages
- Resources are moved from the full-width block above each form to a compact right-side panel beside the form.
- The panel remains near the upper part of the form on desktop.
- On tablets/phones it automatically moves above the form.
- Applies to Project Work, Dissertation and Assessor submission portals.

### Assessor batch submission becomes per-student
- `Number of Reports Being Submitted` controls how many work sections appear.
- Each work has its own:
  - Student First Name
  - Student Surname / Last Name
  - Index Number
  - Programme
  - Assessment Report (required)
  - Claim Form (required)
  - Dissertation (optional)
- Up to 25 reports/works can be submitted in one assessor submission.

### Department admin grouping
- The assessor remains the parent submission record.
- Opening `View / Download Files` shows Work 1, Work 2, etc. under that assessor.
- Each work displays its own student details and its own report, claim form and optional dissertation download.
- Existing/older assessor submissions remain readable through the legacy view.

## Deployment

Commit the replacement files and redeploy the existing Render Web Service. Keep the existing build/start commands and environment variables.
