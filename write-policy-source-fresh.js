const originalFetch = globalThis.fetch.bind(globalThis);

const RAW_POLICY_PREFIX =
  "https://raw.githubusercontent.com/Velorien-Storm/commons-bridge/commons-drive-v0.2/write-authorization-policy.json";
const API_POLICY_URL =
  "https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/write-authorization-policy.json?ref=commons-drive-v0.2";

if (!globalThis.__commonsFreshPolicySourceInstalled) {
  globalThis.fetch = async function commonsFreshPolicyFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;

    if (typeof url === "string" && url.startsWith(RAW_POLICY_PREFIX)) {
      const headers = new Headers(init?.headers || {});
      headers.set("Accept", "application/vnd.github.raw+json");
      headers.set("Cache-Control", "no-cache");
      headers.set("User-Agent", "commons-bridge-authz");

      return originalFetch(`${API_POLICY_URL}&t=${Date.now()}`, {
        ...init,
        headers,
        cache: "no-store",
      });
    }

    return originalFetch(input, init);
  };

  globalThis.__commonsFreshPolicySourceInstalled = true;
}
