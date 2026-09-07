# v32 update: central operations access, activity filtering and compact layouts

- Payroll and Auditor links have been removed from the Department chooser and Department Administration header. The Developer Portal now contains a dedicated **Payroll & Auditor** tab for direct, passwordless operations access.
- Central operations sessions can switch among all four departments from inside the Payroll and Auditor portals.
- Payroll and Auditor pages now filter by department, activity and processing status. Field Experience and Teaching Practice includes its six individual submission options.
- Dissertation Assessment and Dissertation Vetting claims now have a department claim-approval decision. Only approved claims enter Payroll, and they reach the Auditor only after Payroll marks them Approved for Payment.
- Payroll and Auditor tables have been reduced to eight grouped columns with compact actions, quantities and claim checks so the complete workspace fits a normal desktop page.
- The Field Experience and Teaching Practice public form now selects **Department of Education Programmes** by default while still allowing the submitter to change departments.

# v31 update: department resources, Field Experience claims, payment gate and centres

- Every built-in Project Work and Field Experience resource is selected by department. Downloaded Word and Excel headings identify Education Programmes, Business Programmes, Arts and Social Sciences, or Science and Mathematics Programmes as appropriate.
- The supplied Field Experience and Reflection allocation/claim form is available as a department-specific built-in resource.
- Field Experience and Teaching Practice now matches the Undergraduate Project Work control pattern for claimed-quantity validation, row-level inclusion, duplicate-registration warnings, side-by-side reconciliation, corrected registration numbers, re-approval history, approved registers and consolidated exports.
- Payroll receives only Project Work and Field Experience submissions approved by the department. Payroll cannot approve a claim for payment when its claim form is missing or its claimed quantity does not reconcile with approved scores.
- The Auditor's Portal is populated only after Payroll marks a claim **Approved for Payment**. Paid claims remain available for audit history.
- The approved centre-code directory now contains 197 records from `code_centres2. (1)(2).xlsx`. The approved centre names are available to all four departments by default.
- Developer centre management now saves a centre code, official name and department assignments together. A centre can be disabled temporarily and later enabled without deleting its code or assignments.

# v25 update: Study Centre reporting and Centre by Centre scores

- Consolidated and master Undergraduate Project Work score sheets now include a **STUDY CENTRE** column derived from the centre code in each Registration Number using the approved centre-code directory.
- Field Experience and Teaching Practice consolidated/master reports now also include **STUDY CENTRE**, including the separate Field Experience I, II, III, IV, V, Micro-Teaching, Macro-Teaching and Reflection reports.
- **Programme by Centre ZIP** is superseded by **Centre by Centre Scores ZIP**. All students at the same centre are combined in one workbook regardless of programme, sorted by Registration/Index Number, and the workbook is named with the official centre name.
- The Developer Portal manages a separate **Study Centre Code Directory**. The earlier 93-centre directory has been superseded in v31 by the supplied 197-record centre and code directory.
- Department-specific published centre lists are still used for public-portal checkbox selection and remain independent of the reporting directory.

# v22 update: checkbox selection for multiple Project Work study centres

The Undergraduate Project Work public portal now presents department-published study centres as a **checkbox list** instead of a multi-select dropdown. Supervisors/Examiners can tick one or more Distance study centres directly, which is clearer when groups cut across centres and works consistently on desktop and mobile without Ctrl/Cmd multi-selection.

The form displays a live count of selected centres. `Non-Residential` remains mutually exclusive: selecting it clears Distance-centre selections, and selecting a Distance centre clears `Non-Residential`. The server-side v21 multi-centre validation and department-specific centre rules remain unchanged.

No new Render environment variable or npm dependency is required for v22.

# v21 update: multi-centre project work, claim-form ZIPs and Programme by Centre scores

Version 21 extends Undergraduate Project Work administration in four areas.

- **Multiple study centres per Project Work submission.** A supervisor/examiner may select more than one Distance study centre when supervised groups cut across centres. `Non-Residential` remains a separate regular-student stream and must be selected alone. Existing single-centre records remain compatible.
- **Department-specific study-centre publishing.** The Developer Portal now requires the developer to identify which department(s) an uploaded CSV belongs to. The legacy centre list is treated as the Department of Business Programmes list. Uploading a new CSV replaces only the selected department(s). Project Work and Field Experience public forms load centres only after the user selects a department.
- **Selected claim-form packages.** Department users may select Project Work submissions and download their Claim Forms in one ZIP. Officers and Administrators may also email the same ZIP to a department email address using the existing Gmail API. Files are renamed to the Supervisor/Examiner name, with `(2)`, `(3)` etc. added when names repeat. Large packages that are unsafe for Gmail are directed to ZIP download instead.
- **Programme by Centre score ZIP.** In addition to the ordinary consolidated workbook, Distance and Non-Residential Project Work now have a downloadable `Programme by Centre ZIP`. The grouping key is the first three slash-separated parts of the Registration Number. For example, `BCF/CR/01/22/0002` is grouped under `BCF/CR/01`, where `BCF` is the programme and `CR/01` is the centre code. Each group is exported as its own XLSX file, such as `BCF_CR_01.xlsx`, inside one ZIP. Invalid/short registration numbers are retained in `UNCLASSIFIED.xlsx` rather than dropped.

All consolidated Project Work score outputs, Master Project Work score outputs, Programme-by-Centre score files and Field Experience consolidated score outputs are now sorted by **Registration No.** before S/N is assigned.

No new Render environment variable or npm dependency is required for v21. Existing Gmail settings are reused for emailing selected claim-form ZIPs.

# v18 update: exclude Project Work signature/footer rows from score consolidation

Undergraduate Project Work and other score-based exports now explicitly exclude the template footer metadata that appears below the student score table, including **Signature of Supervisor**, **Date**, and **Contact**. These lines are not counted as score rows and cannot appear in Consolidated or Master score sheets.

The fix is backward-compatible. If an older submission already stored these footer lines as extracted rows, the current export/count logic filters them out automatically, so the supervisor does not need to resubmit the workbook. Empty template rows, including rows containing only a pre-filled S/N, continue to be ignored.

# v15 update: Project Work verification gate + Field Experience scores

Public Project Work and Field Experience score submissions remain open, but they do not automatically enter consolidated score outputs. Each submission starts as **Pending Verification**. A department administrator must explicitly approve the record before its student rows enter the relevant consolidated/master score workbook.

Review states are colour coded: Amber = Pending, Green = Approved, Red = Rejected, Blue = Returned for Correction. Automated duplicate/high-volume warnings are advisory only.

A new public portal is available at `/field-experience.html`. It collects supervisor/examiner identity, study centre, number of students/candidates and an Excel score sheet. It uses the same header-only validation as the current Project Work workflow: `S/N | NAME | REGISTRATION NO. | GROUP NO. | TOTAL SCORE`. Empty rows are ignored. Project Work and Field Experience scores are consolidated separately.

The department admin portal still has three top-level tabs. The first tab now contains separate **Undergraduate Project Work** and **Field Experience Score Submissions** subsections, each with its own approval decisions, register, consolidated scores and master scores.

Individual administrator permissions and developer-published resources now also support a separate `field-experience` section.

Optional warning threshold:

```text
PROJECT_HIGH_ROW_WARNING=100
```

# v14 update: undergraduate project-work verification gate

Public project-work submission remains open, but every new project-work submission is stored as **Pending Verification**. Existing project-work records without a review status are also treated as Pending. Pending, Rejected and Returned-for-Correction records do not feed Consolidated Project Scores or Master Project Scores. Only records explicitly marked **Approved** by a project-work Administrator are included.

Project-work submission states are colour coded in the department admin portal:

- Amber = Pending Verification
- Green = Approved
- Red = Rejected
- Blue = Returned for Correction

The administrator can open a project-work record, inspect the supervisor/examiner identity, submitted email, study centre, original score sheet, claim form, supervisor report, completed project-work files, extracted score-row count and submission date/time, then choose **Approve for Consolidation**, **Reject**, or **Return for Correction**. Review actions are recorded with timestamp, administrator identity and an optional note.

Automated warnings are advisory and do not delete or automatically reject a submission. The current checks flag repeated supervisor/examiner submissions, repeated supervisor + study-centre combinations, registration numbers already present in other Approved score sheets, unusually high score-row counts, and expired/revoked secure-link metadata when such metadata exists. The high-row warning threshold defaults to 100 and may be changed with:

```text
PROJECT_HIGH_ROW_WARNING=100
```

The Project Work Register includes review status and review audit fields. The score sheets inside Consolidated Project Scores and Master Project Scores include Approved submissions only.

# v12 update: single secure assessor/vetter assignment workspace

When a department assigns several dissertations to one assessor or vetter, the system sends one email containing one secure assignment link. That workspace handles downloads and per-work report submission. Each work can be submitted separately, progress is retained, and Early Bird status is calculated per work.

# UCC Departmental Submission Portals v10

Three public submission portals and protected departmental administration for:

- Undergraduate Project Work
- Dissertation Submission
- Assessment Report Submission

## v10 additions

- Dissertation assignment email now includes the Assessor Submission Portal link, an 8-week report deadline, and a 4-week Early Bird completion date.
- Department administrators can forward each assessment report and optional reviewed dissertation to the student using the email on the latest matching dissertation submission. The student receives a secure download link. Claim forms are not forwarded.
- Student-feedback forwarding uses colour states: red = not forwarded/action needed, amber = sent but not downloaded, green = downloaded, grey = no matching dissertation email.
- Dissertation portal now supports Fresh Submission and Revised Submission. Revised submissions require a revised dissertation plus one or more reviewers' response files. Title validation runs against the uploaded fresh/revised dissertation.
- Consolidated undergraduate scores exclude empty template rows, including rows containing only a pre-filled S/N.
- Developer portal can create individual administrator accounts, assign departments, submission sections and roles, and enable/disable/delete those accounts.
- Developer portal can upload a CSV to replace the Project Work study-centre list. Put one study centre per row in the first column. A header such as `Study Centre` is optional.

## Administrator roles

- **Viewer**: view records and download files/exports in assigned sections.
- **Officer**: Viewer permissions plus dissertation assignment/revocation/resend and forwarding assessment feedback to students.
- **Administrator**: full access to assigned sections, including deletion.

The original environment-variable account for each department remains a full department master administrator.

## Render

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Keep the persistent disk mounted at the configured `STORAGE_DIR` so submissions, dynamic admin accounts, study centres, resources and assignment metadata survive redeployments.

Existing Gmail variables remain required for assignment and feedback emails:

```text
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_SENDER_EMAIL=department-email@ucc.edu.gh
GMAIL_FROM_NAME=CoDE Academic Submission Portal
```

Optional:

```text
ASSIGNMENT_EXPIRY_DAYS=14
STUDENT_FEEDBACK_EXPIRY_DAYS=30
```

Developer portal credentials:

```text
DEVELOPER_ADMIN_USER=developer
DEVELOPER_ADMIN_PASSWORD=your-secure-password
```

Department master-account environment variables remain unchanged.

## v11 workflow update

- Department admin keeps Fresh Dissertation Submissions and Revised Dissertation Submissions in separate tables.
- The public assessor portal accepts either Assessment Reports or Vetting Reports.
- Department admin keeps Assessment Report Submissions and Vetting Report Submissions in separate tables.
- Dissertation assignment now records an assignment type. Fresh dissertations can only be assigned for Assessment. Revised dissertations can be assigned for Vetting or Assessment.
- Secure assignment emails link to `/assessor.html?assignment=<secure-token>`. The portal retrieves the assigned students from the server and locks student names, index numbers and programmes. Student email is linked server-side and is not exposed for editing.
- A token-linked report submission stores the exact dissertation submission ID for each student, so forwarding feedback uses the email from the correct dissertation record instead of relying on typed names or index numbers.
- Fresh dissertation submissions only accept Assessment feedback forwarding. Student feedback packages contain the report and optional reviewed dissertation only; claim forms are excluded.

## v13: Individual administrator email invitation and password setup

Individual administrator accounts created from the Developer Portal no longer require the developer to choose a permanent password. The developer enters the administrator's name, email address, optional username, assigned department(s), assigned section(s), and role.

The system creates the account in a pending state and emails the administrator a one-time password setup link using the existing Gmail API configuration. The email includes the username and assigned access. The setup link expires after 24 hours by default and becomes invalid immediately after it is used.

Optional environment setting:

```text
ADMIN_INVITATION_EXPIRY_HOURS=24
```

The developer dashboard shows whether an account is Ready, Awaiting setup, Invite expired, Email failed, or Disabled. The developer can resend an invitation. For an already activated account, the same action sends a one-time password reset link without revealing or replacing the current password until the user completes the reset.

The existing Gmail variables are required for invitations:

```text
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_SENDER_EMAIL=...
GMAIL_FROM_NAME=...
```

## v16: Staged dissertation workflow, vetting controls and anonymous feedback

Version 16 strengthens dissertation processing and reviewer confidentiality:

- **Changed titles after review are supported.** Fresh, revised and final submissions validate the title against the dissertation uploaded at that stage. A revised title may therefore differ from the fresh-submission title when a reviewer has recommended a title change. The previous-stage title and lineage are retained for audit purposes.
- **Assessor/vetter identity is never intentionally released through the student feedback route.** Department admins must prepare an anonymised student copy of the report, and optionally an anonymised reviewed dissertation, before forwarding. The original report, claim form and score sheet remain internal. The server also checks extractable document text for the reviewer name/email before accepting the student copy.
- **Fresh dissertation assignments remain Assessment assignments** with a maximum of 3 assessors. Status colours remain red for 0, amber for 1 and green for 2 or 3.
- **Revised dissertation assignments are Vetting assignments** with a maximum of 2 vetters. Revised records show Vetter(s), and the colour changes from red at 0 to green at 1 or 2.
- The Revised Dissertation section has **Email Selected to Vetter**, which creates the same secure one-link workspace used for fresh Assessment assignments.
- The public Dissertation portal now supports **Fresh Submission, Revised Submission and Final Dissertation**. Final submissions require the final dissertation, one or more reviewer-response files and a plagiarism/Turnitin report.
- The department admin portal has separate **Fresh, Revised and Final Dissertation** subsections. Final records are retained as individual submissions and are not assigned for assessment/vetting.
- Every Assessment/Vetting work submitted through a secure assignment now requires **Report + Claim Form + Score Sheet**. A reviewed dissertation remains optional.
- Fresh and Revised Dissertation Registers are exported separately. Each register de-duplicates by index number within that stage and retains the latest submission for that student.
- Department admins can **Return to Student Without Processing** at the Fresh, Revised or Final stage, with standard reasons for unpaid fees, unsatisfactory/invalid Turnitin report, incomplete/invalid reviewer response, or a custom reason. The student receives the reason by Gmail. Active assignment links containing a returned work are updated/revoked as appropriate.
- Public submission pages include an **Admin Login** link. Department admins now have a form-based login and a **Logout** control. Existing Basic-auth access remains as a compatibility fallback.

No new npm dependency or Render environment variable is required for v16.


## v17: Separate Non-Residential regular-student project work

- `Non-Residential` is now a fixed option in the **Undergraduate Project Work** Study Centre dropdown. It is intended for regular students and is not added to the Field Experience study-centre list.
- Project-work submissions are classified as either **Distance** or **Non-Residential (Regular)**. Existing records whose Study Centre is `Non-Residential` are automatically recognised as regular-student records even if they were created before v17.
- Department admins receive Project Work in two separate subsections: **Distance Undergraduate Project Work** and **Non-Residential Undergraduate Project Work**.
- Both streams retain the Pending → Approved → Rejected / Returned review gate. Only Approved records enter consolidated outputs.
- Existing project score exports now contain **Distance students only**.
- New Non-Residential exports are available separately: **Consolidated Non-Residential Scores**, **Master Non-Residential Scores**, and **Non-Residential Project Work Register**.
- Duplicate-registration and repeat-submission warnings are evaluated within the same project stream so a Non-Residential submission does not contaminate Distance verification.
- Field Experience outputs remain unchanged and separate.

No new environment variable or npm dependency is required for v17.


## v20 inline score review

Undergraduate Project Work review now displays all detected student score rows directly beneath the submitted files in the admin submission record. Each valid row has an Include checkbox, checked by default. Department administrators may uncheck individual rows before approval; unchecked rows remain in the original uploaded workbook but are excluded from approved consolidated and master score exports. Blank template rows and supervisor Signature/Date/Contact footer metadata remain excluded automatically.

Fresh and Revised Dissertation registers retain Supervisor's Name as a dedicated column, with each student deduplicated by index number within the relevant submission stage.


## v20 - Returned score submission email notices
- Returning an Undergraduate Project Work submission for correction now requires a reason and emails that reason to the supervisor/examiner through the configured Gmail API.
- Field Experience uses the same correction-email workflow.
- Returned submissions show correction-email status in the review dialog and provide a Resend Correction Email action.
- A failed email does not undo the Returned for Correction review status. The admin is shown the failure and can resend after correcting Gmail or recipient details.

- Resend Correction Email allows an administrator to confirm or override the recipient email for an already-returned score submission without changing the original submission record.

## v23: Field Experience and Teaching Practice

The public Field Experience portal is now **Field Experience and Teaching Practice**. Each submission selects exactly one of six assessment categories: Field Experience I & II, Field Experience III & IV, Field Experience V, Micro-Teaching, Macro-Teaching, or Reflection. The portal validates the Excel score sheet against the selected category and can read the matching worksheet from the supplied six-sheet template workbook.

Department administration groups these submissions into the same six categories. Consolidated and master Field/Teaching workbooks use separate worksheets for each category so that the different score structures are never mixed. Older Field Experience records remain accessible as Previous / Unclassified records. This v23 change is confined to the Field Experience section. Undergraduate Project Work, Dissertation Submission and Assessment/Vetting workflows remain unchanged.


## v24 Field Experience and Teaching Practice update
Field Experience resources are now six separate Excel templates. The public portal supports multiple study-centre checkbox selection. After departmental approval, the admin portal provides individual report downloads for Field Experience I, II, III, IV, V, Micro-Teaching, Macro-Teaching and Reflection, including Consolidated Scores, Programme by Centre ZIP, Master Scores and a Register. Paired input sheets (I & II and III & IV) are split into separate approved outputs.


## v26: Alphabetical study-centre ordering

Public Study Centre choices in Undergraduate Project Work and Field Experience and Teaching Practice are now displayed alphabetically. Approved consolidated score sheets are sorted first by Study Centre name and then by Registration/Index Number within each centre. The separate Field Experience I, II, III, IV, V, Micro-Teaching, Macro-Teaching and Reflection consolidated reports use the same centre-first ordering. Centre by Centre ZIP files continue to sort students by Registration/Index Number within each centre.

No new environment variable or npm dependency is required for v26.


## v27: Configurable Field Experience claim forms and cleaner administration

Field Experience and Teaching Practice now accepts an optional Claim Form by default. The Developer/System Administrator can switch the Claim Form between Optional and Compulsory under Portal Settings; server-side validation follows the saved setting. Department administration has been reorganised into four top-level tabs with additional sub-tabs for Project Work streams, Field Experience assessment categories, Dissertation stages/assignments, and Assessment/Vetting reports. The Developer portal is also tabbed. Study-centre management now supports adding one centre without replacing the full list, deleting individual centres, and adding/updating/deleting individual centre-code directory records while retaining the bulk replacement tools.

No new environment variable or npm dependency is required for v27.

## v28: Project-work reconciliation, claim verification and payment/audit workflow

Version 28 strengthens Undergraduate Project Work verification and downstream claim processing:

- Duplicate approved registration/index numbers now open a reconciliation panel showing both participating score sheets, their supervisors/examiners, the duplicate student row, and the complete extracted score entries for each sheet. Administrators may correct the affected registration/index values and re-approve the participating sheets in one action. Corrected values become the canonical approved rows used by consolidated outputs while the original uploaded workbook and a correction audit history are retained.
- Project Work claim forms can be reviewed directly in an inline frame. PDF/images display inline, DOCX/DOC content is rendered for review, and spreadsheet/CSV claim forms are shown as a table.
- **Total Number of Groups Submitting** accepts forms such as `8`, `eight`, `eight(8)` and `eight (8)`. New Project Work submissions are accepted only when the interpreted claim count equals both the number of distinct `GROUP NO.` values in the score sheet and the number of completed project-work files attached. Existing records display the same reconciliation check in administration.
- Undergraduate Project Work score sheets must contain exactly one Excel worksheet. Multi-sheet Project Work workbooks are rejected before submission.
- Distance and Non-Residential Project Work now each provide an **Approved Register** containing approved submissions only.
- A separate **Payroll Portal** processes approved Project Work claims against the approved register and claim form, with Pending, Verified, Approved for Payment, Paid and Queried/Hold states plus a processing history.
- A separate **Auditor Portal** provides read-only verification of the same approved claims, claim forms, group reconciliation and payroll status.
- Developer-created administrator accounts can be granted Payroll Portal and Auditor Portal access independently by department and role.
- Published resources can now be targeted by both submission portal and department. A resource may therefore be shown only to selected departments on Undergraduate Project Work, Field Experience and Teaching Practice, Dissertation Submission, and/or Assessment Report Submission. Older resources without a department restriction remain globally available for backward compatibility.

No new Render environment variable or npm dependency is required for v28.


## v29 Developer passwordless portal preview

The Developer Administration Portal now includes a **Portal Preview** tab. An authenticated developer can create a short-lived 30-minute department session without knowing or entering a department user's password. The developer can preview a standard Department Administrator, Department Officer, Department Viewer, Payroll Officer or Auditor profile, or select an existing active administrator account and reproduce that account's department/section permissions.

Preview destinations include the Department Administration Portal, Payroll Portal and Auditor's Portal. Public Undergraduate Project Work, Field Experience and Teaching Practice, Dissertation and Assessment Report portals are also linked directly because they do not require login.

All protected preview pages display a **Developer Preview Mode** banner with the identity being previewed, expiry information, a link back to the Developer Portal and an Exit Preview action. Administrative or payroll actions performed during preview remain real actions and are attributed in the audit fields as **Developer Preview as ...** rather than being silently attributed to the impersonated user.

Existing administrator accounts also have a **Preview** button in the Developer Portal. No administrator password, password hash or reset is required for developer preview. The existing developer Basic Authentication remains the security gate for creating preview sessions.


## v30: Responsive Payroll and Auditor portal layout

The Payroll Portal and Auditor Portal now use the full available browser width on desktop. Their approved-claims tables use fixed responsive column proportions, compact spacing and safe wrapping for long references, emails, centre names, notes and status labels. Payroll action buttons are arranged in a compact two-column action grid so the Actions column no longer expands beyond the page. On narrower screens the tables retain horizontal scrolling rather than compressing content to unreadable widths. No payroll, audit, claim-preview or permission logic has changed.

No new Render environment variable or npm dependency is required for v30.
