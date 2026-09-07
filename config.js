window.PORTAL_CONFIG = {
  // Set this to your real backend/serverless endpoint when ready.
  // Example: "https://your-service.onrender.com/api/submissions"
  SUBMISSION_ENDPOINT: "",

  // Only these five headings are validated. Student data and row counts are ignored.
  REQUIRED_COLUMNS: [
    "S/N",
    "NAME",
    "REGISTRATION NO.",
    "GROUP NO.",
    "TOTAL SCORE"
  ],
  HEADER_SEARCH_ROWS: 30,

  // Upload limits in megabytes.
  MAX_CLAIM_MB: 10,
  MAX_REPORT_MB: 10,
  MAX_WORK_MB: 50,
  MAX_SCORE_MB: 10
};
