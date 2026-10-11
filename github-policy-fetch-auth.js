// Candidate r2: authenticate only the designated GitHub policy contents API endpoint.
const POLICY_ORIGIN = 'https://api.github.com';
const POLICY_PATH = '/repos/Velorien-Storm/commons-bridge/contents/write-authorization-policy.json';

export function makePolicyFetch(originalFetch, tokenProvider = () => process.env.COMMONS_POLICY_GITHUB_TOKEN) {
  return async function policyFetch(input, init = {}) {
    const inputUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let url;
    try { url = new URL(inputUrl); } catch { return originalFetch(input, init); }
    if (url.origin !== POLICY_ORIGIN || url.pathname !== POLICY_PATH) {
      return originalFetch(input, init);
    }
    if (url.searchParams.getAll('ref').length !== 1 || url.searchParams.get('ref') !== 'commons-drive-v0.2') {
      throw new Error('Policy source branch is not approved.');
    }
    const token = tokenProvider();
    if (!token || typeof token !== 'string') {
      throw new Error('Current authorization policy cannot be fetched: policy credential is not configured.');
    }
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/vnd.github.raw+json');
    headers.set('Cache-Control', 'no-cache');
    headers.set('User-Agent', 'commons-bridge-authz');
    return originalFetch(input, { ...init, headers, cache: 'no-store', redirect: 'error' });
  };
}

if (!globalThis.__commonsPolicyGithubAuthenticationInstalled) {
  globalThis.fetch = makePolicyFetch(globalThis.fetch.bind(globalThis));
  globalThis.__commonsPolicyGithubAuthenticationInstalled = true;
}
