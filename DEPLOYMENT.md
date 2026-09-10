# CoDE Academic Services Portal deployment guide

## Render service

Deploy this folder as one Node web service using the included `render.yaml`.

```text
Build command: npm install
Start command: npm start
Health check: /health
```

Attach the persistent disk at `/var/data/codeacademicservices`. Do not deploy a new service without the existing disk or the saved submissions, complaints, accounts and resources will not be present.

## Required production settings

Set these values in Render without committing their real values:

```env
PUBLIC_BASE_URL=https://your-approved-domain.example
DEVELOPER_ADMIN_PASSWORD=<strong unique password>
EDUCATION_ADMIN_PASSWORD=<strong unique password>
BUSINESS_ADMIN_PASSWORD=<strong unique password>
ARTS_SOCIAL_ADMIN_PASSWORD=<strong unique password>
SCIENCE_MATH_ADMIN_PASSWORD=<strong unique password>
SUPPORT_STATUS_TOKEN_SECRET=<strong random value different from every password>
SUPPORT_ALLOWED_EMAIL_DOMAINS=ucc.edu.gh
```

Use the existing Gmail OAuth settings for invitation, assignment and case-update email delivery. Add Twilio settings only if SMS or WhatsApp has been approved and configured.

`PUBLIC_BASE_URL` must be the exact HTTPS production origin. Assignment, password-setup and tracking links use it. Do not leave it pointing to an old Render hostname after a custom domain is activated.

## Chrome and iPhone security-warning recovery

A browser-wide red warning is a reputation or security classification, not an ordinary page-layout error. Do not instruct staff or students to bypass it.

1. Pause distribution of affected links while the warning is active.
2. In Render, confirm the deployed Git commit, deploy history, environment variables and authorised administrators. Remove any unknown deployment or credential.
3. Rotate exposed or suspicious passwords, Gmail OAuth credentials, Twilio credentials and `SUPPORT_STATUS_TOKEN_SECRET`.
4. Verify the production property in Google Search Console. Open **Security issues**, inspect every listed issue and sample URL, and test both desktop and mobile rendering.
5. Fix every affected page, then request a review from the Security issues report. Google says partial cleanup is not sufficient.
6. If Search Console reports no security issue and the warning is demonstrably incorrect, submit the exact affected URL through Google Safe Browsing's incorrect-warning form.
7. Recheck Chrome, Safari on an iPhone, and a clean private-browsing session only after the review has completed.

Official references:

- Google Search Console Security issues report: https://support.google.com/webmasters/answer/9044101
- Google Safe Browsing incorrect-warning form: https://safebrowsing.google.com/safebrowsing/report_error/
- Chrome unsafe-site warnings: https://support.google.com/chrome/answer/99020
- Apple Safari privacy and fraudulent-site warnings: https://www.apple.com/legal/privacy/data/en/safari/

## Recommended production domain

Use an institution-controlled HTTPS hostname, ideally a University of Cape Coast subdomain approved by ICT. A custom domain improves identity clarity, but it does not erase an active Safe Browsing classification. Complete the security review first and set `PUBLIC_BASE_URL` to the final hostname.

## Staff assignment security

Version 39 no longer reveals a complaint, student details or evidence merely because someone possesses an assignment URL.

- The functional-unit administrator must first create and activate an individual staff account with the same institutional email and unit.
- Opening the emailed assignment link redirects an unauthenticated person to the staff login.
- The signed-in account email must match the assigned email. A unit administrator can open the link for authorised oversight.
- The indicator becomes yellow only after authorised access. It becomes green only after the resolution checklist and note are submitted.
- Assignment and evidence pages send `no-store` and `noindex` controls.

## Directorate monitoring

The two Directorate roles receive the same institution-wide, non-confidential monitoring scope as the Provost dashboard. They can view totals, statuses, functional-unit statistics, study-centre performance and downloadable registers for all standard complaints and requests. Restricted sensitive cases remain visible only to the Provost and Confidential Case Handler.

## Release verification

Run before deployment:

```text
npm install
npm run check
npm run test:portals
```

After deployment:

1. Confirm `/health` returns a successful response.
2. Confirm the homepage, student support, staff login and developer portal load on Chrome and Safari.
3. Assign a test case to an activated institutional staff account.
4. Confirm the link requires sign-in, rejects another staff account and shows no case data before authentication.
5. Confirm the assignment changes red to yellow after authorised opening and green after resolution.
6. Sign in as each Directorate role and confirm the overview and downloadable register include complaints from every functional unit while restricted cases stay hidden.
