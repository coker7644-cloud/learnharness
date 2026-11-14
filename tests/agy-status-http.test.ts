import assert from "node:assert/strict";
import { test } from "node:test";
import { agyInstallationResponse as respond } from "../src/server/agy.ts";

const agyInstallationResponse: typeof respond = (request, inspect) => respond(request, inspect, () => true);

function request(headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/agy", { headers: { "x-learnharness-agy": "1", ...headers } });
}

const status = { state: "not-found" as const, version: null, minimumVersion: "1.5.0" };

for (const headers of [
	{ origin: "https://attacker.invalid" },
	{ "sec-fetch-site": "cross-site" },
	{ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
	{ origin: "null" },
	{ "x-learnharness-agy": "" },
] as Record<string, string>[]) {
	test(`unsafe status request ${JSON.stringify(headers)} never invokes the probe`, async () => {
		let probes = 0;
		const response = await agyInstallationResponse(request(headers), async () => { probes++; return status; });
		assert.equal(response.status, 403);
		assert.equal(probes, 0);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
	});
}

test("disabled opt-in never starts even a version probe", async () => {
	let probes = 0;
	const response = await respond(request(), async () => { probes++; return status; }, () => false);
	assert.equal(response.status, 403);
	assert.equal(probes, 0);
});

test("ordinary image/subresource GET without intent header cannot start a probe", async () => {
	const response = await agyInstallationResponse(new Request("http://localhost:3000/api/agy"), async () => assert.fail("must not probe"));
	assert.equal(response.status, 403);
});

for (const headers of [{}, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }] as Record<string, string>[]) {
	test(`legitimate Providers GET ${JSON.stringify(headers)} is supported`, async () => {
		let probes = 0;
		const response = await agyInstallationResponse(request(headers), async () => { probes++; return status; });
		assert.equal(response.status, 200);
		assert.equal(probes, 1);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), status);
	});
}
