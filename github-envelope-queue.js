const REPOSITORY = "Velorien-Storm/commons-bridge";
const BRANCH = "commons-write-queue";

function headers() {
  const token = process.env.GITHUB_QUEUE_TOKEN;
  if (!token) throw new Error("The encrypted-envelope queue credential is unavailable.");
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "commons-bridge-envelope-queue" };
}

function assertOwnedPath(lane, requestId) {
  if (!lane || !/^[a-z0-9-]+$/.test(lane.route_slug) || !/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Server-owned queue binding is invalid.");
  return `outbox/${lane.route_slug}/${requestId}.json`;
}

export async function enqueueEncryptedEnvelope({ lane, residentId, requestId, envelope }) {
  if (lane.policy_resident_id !== residentId || envelope?.request_id !== requestId || envelope?.version !== 2) throw new Error("Resident envelope binding is invalid.");
  const queuePath = assertOwnedPath(lane, requestId);
  const apiPath = `https://api.github.com/repos/${REPOSITORY}/contents/${queuePath}`;
  const existing = await fetch(`${apiPath}?ref=${BRANCH}`, { headers: headers(), cache: "no-store" });
  if (existing.ok) {
    const existingBody = await existing.json();
    const commits = await fetch(`https://api.github.com/repos/${REPOSITORY}/commits?sha=${BRANCH}&path=${encodeURIComponent(queuePath)}&per_page=1`, { headers: headers(), cache: "no-store" });
    const history = commits.ok ? await commits.json() : [];
    return { status: "queued_for_airlock", resident: residentId, request_id: requestId, queue_path: queuePath, commit_identifier: history[0]?.sha || existingBody.sha, idempotency: "already_queued" };
  }
  if (existing.status !== 404) throw new Error(`Encrypted-envelope queue lookup failed (HTTP ${existing.status}).`);
  const body = { message: `Queue ${lane.expected_public_identity} approved Commons reply`, branch: BRANCH, content: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64") };
  const created = await fetch(apiPath, { method: "PUT", headers: headers(), body: JSON.stringify(body) });
  const result = await created.json();
  if (!created.ok || !result?.commit?.sha) throw new Error(`Encrypted-envelope queue write failed (HTTP ${created.status}).`);
  return { status: "queued_for_airlock", resident: residentId, request_id: requestId, queue_path: queuePath, commit_identifier: result.commit.sha, idempotency: "created" };
}

export const __test = { assertOwnedPath };
