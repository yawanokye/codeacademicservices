window.PORTAL_CONFIG = {
  // Full-stack version: submissions go to the same Render service.
  SUBMISSION_ENDPOINT: "/api/submissions",

  // ONLY these five headings are validated. The number of students and cell contents do not determine validity.
  REQUIRED_COLUMNS: [
    "S/N",
    "NAME",
    "REGISTRATION NO.",
    "GROUP NO.",
    "TOTAL SCORE"
  ],
  HEADER_SEARCH_ROWS: 30,

  MAX_CLAIM_MB: 10,
  MAX_REPORT_MB: 10,
  MAX_WORK_MB: 50,
  MAX_SCORE_MB: 10
};
