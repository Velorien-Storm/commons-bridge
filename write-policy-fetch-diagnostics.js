const previousFetch = globalThis.fetch.bind(globalThis);

const POLICY_API_PREFIX =
  "https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/write-authorization-policy.json";
const POLICY_RAW_PREFIX =
  "https://raw.githubusercontent.com/Velorien-Storm/commons-bridge/commons-drive-v0.2/write-authorization-policy.json";

function isPolicyRequest(url) {
  return (
    typeof url === "string" &&
    (url.startsWith(POLICY_API_PREFIX) || url.startsWith(POLICY_RAW_PREFIX))
  );
}

function headerValue(response, name) {
  const value = response?.headers?.get?.(name);
  return value === null || value === undefined || value === "" ? null : value;
}

function safeErrorMessage(error) {
  const message = String(error?.message || error || "unknown fetch error");
  return message.slice(0, 300);
}

if (!globalThis.__commonsPolicyFetchDiagnosticsInstalled) {
  globalThis.fetch = async function commonsPolicyFetchDiagnostics(input, init) {
    const url = typeof input === "string" ? input : input?.url;

    if (!isPolicyRequest(url)) {
      return previousFetch(input, init);
    }

    try {
      const response = await previousFetch(input, init);

      if (!response.ok) {
        console.warn(
          JSON.stringify({
            event: "authorization_policy_fetch_failed",
            upstream_status: response.status,
            rate_limit_limit: headerValue(response, "x-ratelimit-limit"),
            rate_limit_remaining: headerValue(response, "x-ratelimit-remaining"),
            rate_limit_reset: headerValue(response, "x-ratelimit-reset"),
            rate_limit_resource: headerValue(response, "x-ratelimit-resource"),
            retry_after: headerValue(response, "retry-after"),
          })
        );
      }

      return response;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "authorization_policy_fetch_error",
          error_name: String(error?.name || "Error"),
          error_message: safeErrorMessage(error),
        })
      );
      throw error;
    }
  };

  globalThis.__commonsPolicyFetchDiagnosticsInstalled = true;
}
