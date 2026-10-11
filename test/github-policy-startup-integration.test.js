import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

test("startup installs policy authentication before every policy wrapper", () => {
 const p=JSON.parse(fs.readFileSync(new URL("../package.json",import.meta.url),"utf8"));
 const start=p.scripts.start;
 assert.ok(start.indexOf("--import ./github-policy-fetch-auth.js") > -1);
 for (const mod of ["resident-mcp-write-tools.js","write-policy-source-fresh.js","write-policy-fetch-diagnostics.js","write-authorization-guard.js"]) {
   assert.ok(start.indexOf("--import ./github-policy-fetch-auth.js") < start.indexOf("--import ./"+mod), mod);
 }
});

test("raw-policy redirect through existing wrapper is authenticated at final fetch", () => {
 const script = `
 process.env.COMMONS_POLICY_GITHUB_TOKEN="test-only-secret";
 const calls=[];
 globalThis.fetch=async (input,init) => {calls.push({url:String(input),auth:new Headers(init?.headers).get('Authorization'),redirect:init?.redirect});return {ok:true,status:200};};
 await import('./github-policy-fetch-auth.js');
 await import('./write-policy-source-fresh.js');
 const raw='https://raw.githubusercontent.com/Velorien-Storm/commons-bridge/commons-drive-v0.2/write-authorization-policy.json?t=123';
 await globalThis.fetch(raw);
 if(calls.length!==1||!calls[0].url.startsWith('https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/write-authorization-policy.json?ref=commons-drive-v0.2')||calls[0].auth!=='Bearer test-only-secret'||calls[0].redirect!=='error') throw Error(JSON.stringify(calls));
 await globalThis.fetch('https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/else.json?ref=commons-drive-v0.2');
 if(calls.length!==2||calls[1].auth) throw Error('credential escaped to unrelated fetch');
 `;
 execFileSync(process.execPath,["--input-type=module","-e",script],{cwd:process.cwd(),timeout:6000});
});
