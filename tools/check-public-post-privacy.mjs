import fs from "fs";

const [contentPath] = process.argv.slice(2);
if (!contentPath) {
  console.error("Usage: node tools/check-public-post-privacy.mjs <content.txt>");
  process.exit(2);
}

const content = fs.readFileSync(contentPath, "utf8");
const findings = [];

function add(code, message) {
  findings.push({ code, message });
}

// High-confidence patterns only. Semantic privacy rules still require human/model review.
if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(content)) {
  add("EMAIL", "Possible email address detected.");
}

if (/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/.test(content)) {
  add("PHONE", "Possible North American phone number detected.");
}

if (/\b\d{5}(?:-\d{4})?\b/.test(content)) {
  add("POSTAL_CODE", "Possible US ZIP/postal code detected.");
}

if (/\b-?(?:[1-8]?\d(?:\.\d+)?|90(?:\.0+)?)[,\s]+-?(?:1[0-7]\d(?:\.\d+)?|180(?:\.0+)?|\d?\d(?:\.\d+)?)\b/.test(content)) {
  add("COORDINATES", "Possible latitude/longitude pair detected.");
}

if (/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Circle|Cir\.?|Way|Parkway|Pkwy\.?)\b/i.test(content)) {
  add("STREET_ADDRESS", "Possible street address detected.");
}

if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
  add("PRIVATE_KEY", "Private-key material detected.");
}

if (/\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(content)) {
  add("CREDENTIAL", "Possible API/access credential detected.");
}

// Optional private literal denylist. Keep actual protected terms OUT of the public repo.
// Supply a base64-encoded JSON array through COMMONS_WRITE_PROTECTED_TERMS_B64.
const protectedTermsB64 = process.env.COMMONS_WRITE_PROTECTED_TERMS_B64;
if (protectedTermsB64) {
  try {
    const decoded = Buffer.from(protectedTermsB64, "base64").toString("utf8");
    const terms = JSON.parse(decoded);
    if (!Array.isArray(terms)) throw new Error("not an array");
    const lower = content.toLocaleLowerCase("en-US");
    if (terms.some((term) => typeof term === "string" && term.trim() && lower.includes(term.trim().toLocaleLowerCase("en-US")))) {
      add("PROTECTED_TERM", "Protected private identifier or location term detected.");
    }
  } catch {
    add("CONFIG", "Protected-term privacy configuration could not be parsed.");
  }
}

const result = {
  ok: findings.length === 0,
  rule: "Commons Public Posting Privacy Rule v1",
  findings,
  reminder: "Regex checks are only a backstop. Review names, relationships, location specificity, live-location/absence clues, private-source material, and mosaic identification before public posting.",
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exit(result.ok ? 0 : 1);
