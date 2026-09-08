import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { verifyReleaseBundle } from "./release-bundle.mjs";

export const publishChromeStore = async ({ bytes, version, env, request = fetch, wait = delay }) => {
  for (const key of ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_PUBLISHER_ID", "CWS_EXTENSION_ID"]) {
    if (!env[key]?.trim()) throw new Error(`${key} is required.`);
  }
  if (!/^[a-p]{32}$/u.test(env.CWS_EXTENSION_ID)
    || !/^[A-Za-z0-9_-]+$/u.test(env.CWS_PUBLISHER_ID)) throw new Error("Invalid Chrome Web Store identity.");
  const json = async (url, options) => {
    const response = await request(url, { ...options, signal: AbortSignal.timeout(120_000), redirect: "error" });
    if (!response.ok) throw new Error(`Chrome Web Store request failed: HTTP ${response.status}. Check the store dashboard before retrying.`);
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result) || result.error) {
      throw new Error("Chrome Web Store returned an invalid response. Check the store dashboard before retrying.");
    }
    return result;
  };
  const token = await json("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.CWS_CLIENT_ID, client_secret: env.CWS_CLIENT_SECRET,
      refresh_token: env.CWS_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Google returned no access token.");
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const name = `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;
  const base = `https://chromewebstore.googleapis.com/v2/${name}`;
  const checkIdentity = (result) => {
    if (result.name !== name || result.itemId !== env.CWS_EXTENSION_ID) throw new Error("Chrome Web Store returned another item identity.");
  };
  const uploaded = await json(`https://chromewebstore.googleapis.com/upload/v2/${name}:upload`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: bytes,
  });
  checkIdentity(uploaded);
  let state = uploaded.uploadState;
  if (state === "SUCCEEDED" && uploaded.crxVersion !== version) throw new Error("Chrome Web Store uploaded version mismatch.");
  for (let attempt = 0; ["IN_PROGRESS", "UPLOAD_IN_PROGRESS"].includes(state) && attempt < 30; attempt += 1) {
    await wait(10_000);
    const status = await json(`${base}:fetchStatus`, { headers });
    checkIdentity(status);
    state = status.lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error("Chrome Web Store upload did not succeed. Nothing was submitted for review.");
  const published = await json(`${base}:publish`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", skipReview: false, blockOnWarnings: true }),
  });
  checkIdentity(published);
  if (!["PENDING_REVIEW", "PUBLISHED", "PUBLISHED_TO_TESTERS"].includes(published.state)) {
    throw new Error("Chrome Web Store did not accept the submission. Inspect the store dashboard before retrying.");
  }
  return published.state;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: publish-chrome-store.mjs RELEASE_BUNDLE_DIRECTORY");
  const { bridge } = await verifyReleaseBundle(path.resolve(directory), {
    repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA,
    runId: process.env.RELEASE_RUN_ID, runAttempt: process.env.RELEASE_RUN_ATTEMPT,
  });
  const state = await publishChromeStore({ ...bridge, env: process.env });
  console.log(`Chrome Web Store submission state: ${state}. Store review and availability remain separate.`);
}
