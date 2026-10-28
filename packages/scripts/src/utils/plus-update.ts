/* global GM_xmlhttpRequest */
import valid from 'semver/functions/valid';
import gt from 'semver/functions/gt';
import repository from '../config/plus-repository.json';

export const PLUS_REPOSITORY = repository.repository;
export const PLUS_REPO_URL = 'https://github.com/' + PLUS_REPOSITORY;
export const PLUS_RELEASES_URL = PLUS_REPO_URL + '/releases';
export const PLUS_RELEASE_API = 'https://api.github.com/repos/' + PLUS_REPOSITORY + '/releases/latest';

export interface PlusRelease {
	version: string;
	tag: string;
	notes: string;
	pageUrl: string;
	downloadUrl: string;
	ready: boolean;
}

export function parsePlusRelease(value: any): PlusRelease | undefined {
	if (!value || typeof value !== 'object' || typeof value.tag_name !== 'string') {
		throw new Error('GitHub 发布信息格式错误');
	}
	if (value.draft || value.prerelease) return;
	const tag = value.tag_name.trim();
	const version = valid(tag);
	if (!version || version.includes('-')) throw new Error('发布标签不是有效的正式版本号：' + tag);
	const base = PLUS_RELEASES_URL + '/download/' + encodeURIComponent(tag) + '/';
	const assets: any[] = Array.isArray(value.assets) ? value.assets : [];
	const hasAsset = (name: string) =>
		assets.some(
			(asset) =>
				asset.name === name &&
				asset.state === 'uploaded' &&
				asset.size > 0 &&
				asset.browser_download_url === base + name
		);
	return {
		version,
		tag,
		notes: typeof value.body === 'string' ? value.body : '',
		pageUrl: PLUS_RELEASES_URL + '/tag/' + encodeURIComponent(tag),
		downloadUrl: base + 'ocs.user.js',
		ready: hasAsset('ocs.user.js') && hasAsset('ocs.meta.js')
	};
}

export function shouldNotifyPlusRelease(release: PlusRelease | undefined, current: string, ignored: string[]): boolean {
	return !!release?.ready && !!valid(current) && !ignored.includes(release.version) && gt(release.version, current);
}

/** Public release metadata only: no AI keys or page cookies are sent to GitHub. */
export function getLatestPlusRelease(): Promise<PlusRelease | undefined> {
	return new Promise((resolve, reject) => {
		if (typeof GM_xmlhttpRequest === 'undefined') {
			reject(new Error('检查更新需要脚本猫或 Tampermonkey'));
			return;
		}
		GM_xmlhttpRequest({
			url: PLUS_RELEASE_API,
			method: 'GET',
			anonymous: true,
			timeout: 20_000,
			headers: { Accept: 'application/vnd.github+json' },
			onload: (response) => {
				if (response.status === 404) {
					resolve(undefined);
					return;
				}
				if (response.status !== 200) {
					reject(
						new Error(
							response.status === 403 || response.status === 429
								? 'GitHub 暂时限制请求，请稍后重试或直接查看发布页。'
								: '检查更新失败：GitHub HTTP ' + response.status
						)
					);
					return;
				}
				try {
					resolve(parsePlusRelease(JSON.parse(response.responseText)));
				} catch (error) {
					reject(error instanceof Error ? error : new Error('发布信息解析失败'));
				}
			},
			onerror: () => reject(new Error('无法连接 GitHub，请检查网络或直接查看发布页。')),
			ontimeout: () => reject(new Error('检查更新超时，请重试。')),
			onabort: () => reject(new Error('更新检查已取消。'))
		});
	});
}
