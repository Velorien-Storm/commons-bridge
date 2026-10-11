import test from "node:test";
import assert from "node:assert/strict";
import { makePolicyFetch } from "../github-policy-fetch-auth.js";

const GOOD = "https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/write-authorization-policy.json?ref=commons-drive-v0.2";
test("policy credential is confined to approved path and ref", async () => {
  const calls = [];
  const wrapped = makePolicyFetch(async (url, opts) => { calls.push({url: String(url), opts}); return {ok:true,status:200}; }, () => "test-token");
  await wrapped(GOOD);
  assert.equal(new Headers(calls[0].opts.headers).get("authorization"), "Bearer test-token");
  await wrapped("https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/unrelated.json?ref=commons-drive-v0.2");
  assert.equal(calls[1].opts, undefined);
  assert.equal(calls.length, 2);
});
test("rejects duplicate or conflicting ref before fetch", async () => {
  let calls=0;
  const wrapped=makePolicyFetch(async()=>{calls++;return {ok:true};},()=> "test-token");
  await assert.rejects(wrapped(GOOD+"&ref=other"),/branch is not approved/);
  await assert.rejects(wrapped(GOOD+"&ref=commons-drive-v0.2"),/branch is not approved/);
  await assert.rejects(wrapped(GOOD.replace("commons-drive-v0.2","main")),/branch is not approved/);
  assert.equal(calls,0);
});
test("no credential fails closed", async () => {
  let calls=0;
  const wrapped=makePolicyFetch(async()=>{calls++;return {ok:true};},()=>undefined);
  await assert.rejects(wrapped(GOOD),/credential is not configured/);
  assert.equal(calls,0);
});
test("redirect is disabled, HTTP errors are not retried, and Request works", async () => {
  let calls=0;
  const wrapped=makePolicyFetch(async(input,opts)=>{
    calls++;
    assert.equal(opts.redirect,"error");
    assert.equal(new Headers(opts.headers).get("authorization"),"Bearer test-token");
    return {ok:false,status:403};
  },()=> "test-token");
  const result=await wrapped(new Request(GOOD));
  assert.equal(result.status,403);
  assert.equal(calls,1);
});
