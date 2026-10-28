import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserScript, DEFAULT_METADATA, CreateOptions } from '../packages/utils/src/common/script.builder';
import {
	PLUS_REPOSITORY,
	PLUS_RELEASES_URL,
	PLUS_RELEASE_API,
	parsePlusRelease,
	getLatestPlusRelease,
	shouldNotifyPlusRelease
} from '../packages/scripts/src/utils/plus-update';

const tag = 'v5.3.0';
const base = PLUS_RELEASES_URL + '/download/' + tag + '/';
const release = {
	tag_name: tag,
	draft: false,
	prerelease: false,
	body: 'Plus 更新说明',
	assets: ['ocs.user.js', 'ocs.meta.js'].map((name) => ({
		name,
		state: 'uploaded',
		size: 100,
		browser_download_url: base + name
	}))
};

async function main() {
	assert.equal(PLUS_REPOSITORY, 'broken-star1999/ocsjs-plus');
	const ready = parsePlusRelease(release)!;
	assert.equal(ready.version, '5.3.0');
	assert.equal(ready.ready, true);
	assert.equal(ready.notes, 'Plus 更新说明');
	assert.equal(ready.downloadUrl, base + 'ocs.user.js');
	assert.equal(ready.pageUrl, PLUS_RELEASES_URL + '/tag/' + tag);
	assert.equal(parsePlusRelease({ ...release, draft: true }), undefined);
	assert.equal(parsePlusRelease({ ...release, prerelease: true }), undefined);
	assert.throws(() => parsePlusRelease({ ...release, tag_name: 'not-a-version' }), /版本号/);
	assert.throws(() => parsePlusRelease({ ...release, tag_name: '5.3.0-beta.1' }), /正式版本号/);
	assert.throws(() => parsePlusRelease(null), /格式错误/);
	assert.equal(parsePlusRelease({ ...release, assets: [] })!.ready, false);
	assert.equal(parsePlusRelease({ ...release, assets: release.assets.slice(0, 1) })!.ready, false);
	const wrongRepo = {
		...release,
		assets: release.assets.map((asset) => ({
			...asset,
			browser_download_url: asset.browser_download_url.replace(PLUS_REPOSITORY, 'ocsjs/ocsjs')
		}))
	};
	assert.equal(parsePlusRelease(wrongRepo)!.ready, false, 'upstream assets are never offered as Plus updates');
	assert.equal(
		parsePlusRelease({ ...release, assets: release.assets.map((asset) => ({ ...asset, size: 0 })) })!.ready,
		false
	);
	assert.equal(shouldNotifyPlusRelease(ready, '5.2.3', []), true);
	assert.equal(shouldNotifyPlusRelease(ready, '5.3.0', []), false);
	assert.equal(shouldNotifyPlusRelease(ready, '5.4.0', []), false);
	assert.equal(shouldNotifyPlusRelease(ready, 'invalid', []), false);
	assert.equal(shouldNotifyPlusRelease(ready, '5.2.3', ['5.3.0']), false);
	assert.equal(shouldNotifyPlusRelease(undefined, '5.2.3', []), false);
	assert.equal(shouldNotifyPlusRelease({ ...ready, ready: false }, '5.2.3', []), false);
	let request: any;
	let status = 200;
	let responseText = JSON.stringify(release);
	let failure = '';
	(globalThis as any).GM_xmlhttpRequest = (options: any) => {
		request = options;
		queueMicrotask(() => {
			if (failure) options[failure]();
			else options.onload({ status, responseText });
		});
	};
	assert.deepEqual(await getLatestPlusRelease(), ready);
	assert.equal(request.url, PLUS_RELEASE_API);
	assert.equal(request.method, 'GET');
	assert.equal(request.anonymous, true);
	assert.equal(request.timeout, 20_000);
	assert.equal(request.headers.Authorization, undefined);
	assert.equal(request.data, undefined);
	status = 404;
	assert.equal(await getLatestPlusRelease(), undefined);
	for (status of [403, 429]) await assert.rejects(getLatestPlusRelease(), /限制请求/);
	status = 500;
	await assert.rejects(getLatestPlusRelease(), /HTTP 500/);
	status = 200;
	responseText = 'invalid JSON';
	await assert.rejects(getLatestPlusRelease());
	for (failure of ['onerror', 'ontimeout', 'onabort']) await assert.rejects(getLatestPlusRelease());
	delete (globalThis as any).GM_xmlhttpRequest;
	// Building a release must not leak its remote update URLs into a later dev build.
	const temporary = mkdtempSync(join(tmpdir(), 'ocs-plus-update-'));
	const entry = join(temporary, 'entry.js');
	const production = join(temporary, 'production.user.js');
	const development = join(temporary, 'development.user.js');
	const defaults = JSON.stringify(DEFAULT_METADATA);
	try {
		writeFileSync(entry, '// test entry');
		const options: CreateOptions = {
			parseRequire: false,
			parseResource: false,
			resourceBuilder: () => '',
			metaDataFormatter: { header: '==UserScript==', footer: '==/UserScript==', prefix: '// ', symbol: '@', gap: ' ' },
			entry,
			dist: production,
			metadata: {
				name: 'test',
				version: '5.3.0',
				description: '',
				author: '',
				license: 'MIT',
				namespace: PLUS_REPOSITORY,
				homepage: '',
				source: '',
				icon: '',
				connect: ['*'],
				match: [],
				grant: [],
				require: [],
				resource: [],
				'run-at': 'document-start',
				updateURL: base + 'ocs.meta.js',
				downloadURL: base + 'ocs.user.js'
			}
		};
		await createUserScript(options);
		assert.equal(JSON.stringify(DEFAULT_METADATA), defaults, 'build options must not mutate shared defaults');
		const metadata = { ...options.metadata };
		delete metadata.updateURL;
		delete metadata.downloadURL;
		await createUserScript({ ...options, dist: development, metadata });
		assert.match(readFileSync(production, 'utf8'), /@updateURL/);
		assert.doesNotMatch(readFileSync(development, 'utf8'), /@(?:updateURL|downloadURL)/);
	} finally {
		for (const file of [entry, production, development]) if (existsSync(file)) unlinkSync(file);
		rmdirSync(temporary);
	}
	console.log(
		'Plus update checks passed: own repository, stable versions, complete assets, no downgrade, ignored versions and HTTP failures.'
	);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
