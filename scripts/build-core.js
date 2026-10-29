// @ts-check

const { series } = require('gulp');
const del = require('del');
const util = require('util');
const { version } = require('../package.json');
const { repository } = require('../packages/scripts/src/config/plus-repository.json');
const repositoryUrl = 'https://github.com/' + repository;
/** @type {(...args: any[])=> Promise<void>} */
const execOut = util.promisify(require('./utils').execOut);
const { createUserScript, createMetaFile } = require('../packages/utils');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const { build: buildStyle } = require('./build-style');

dotenv.config();

const distPath = process.env.BUILD_PATH || '../dist';
console.log('BUILD_PATH: ', distPath);
const distResolvedPath = path.resolve(__dirname, distPath);

function cleanOutput() {
	return del([distPath, '../lib'], { force: true });
}

async function testResolver() {
	await execOut('tsx ../tests/resolver.test.ts');
}

async function buildPackages() {
	await execOut('tsc', { cwd: '../packages/core' });
	await execOut('vite build', { cwd: '../packages/core' });
	await execOut('tsc', { cwd: '../packages/scripts' });
	await execOut('vite build', { cwd: '../packages/scripts' });
}

async function createUserJs() {
	/** 模拟浏览器环境 */
	require('browser-env')();

	/** 先编译样式（easy-us 基础样式 + OCS 自定义样式），保证 style.css 为最新 */
	await buildStyle();
	const CSS_PATH = path.join(__dirname, '../packages/scripts/assets/css/style.css');

	// @ts-ignore
	globalThis.unsafeWindow = {};

	/** @type {import('../packages/scripts/src/index')} */
	// @ts-ignore
	const ocs = require(path.join(distPath, 'index.js'));

	/** @return {import('../packages/utils').CreateOptions} */
	const createOptions = () => {
		const { CXProject, ZHSProject, ZJYProject, IcveMoocProject, ICourseProject, YKTProject } = ocs;
		const projectList = [CXProject, ZHSProject, ZJYProject, IcveMoocProject, ICourseProject, YKTProject]
			.map((s) => `【${s.name}】`)
			.join(' ');

		const matchMetadata = Array.from(
			new Set(
				ocs
					.definedProjects()
					.map((p) => (p.domains || []).map((d) => `*://*.${d}/*`))
					.flat()
			)
		);

		return {
			parseRequire: true,
			parseResource: true,
			resourceBuilder: (key, value) => `const ${key} = \`${value}\`;`,
			metaDataFormatter: {
				header: '==UserScript==',
				footer: '==/UserScript==',
				prefix: '// ',
				symbol: '@',
				gap: '\t'.repeat(4)
			},
			metadata: {
				name: 'OCS Plus 网课助手',
				version: version,
				description: [
					'OCS Plus 网课助手，基于 OCS 扩展，支持 OpenAI 兼容接口 AI 答题及自动获取模型列表。',
					'项目 ' + repositoryUrl + ' ，支持 ',
					projectList,
					'等网课的学习，作业。具体的功能请查看脚本悬浮窗中的教程页面。'
				].join(' '),
				author: 'broken-star1999 (OCS Plus), enncy (OCS)',
				license: 'MIT',
				namespace: repositoryUrl,
				homepage: repositoryUrl,
				source: repositoryUrl,
				updateURL: repositoryUrl + '/releases/latest/download/ocs.meta.js',
				downloadURL: repositoryUrl + '/releases/latest/download/ocs.user.js',
				icon: 'https://cdn.ocsjs.com/logo.png',
				connect: [
					'*',
					// Declare known services explicitly; wildcard custom hosts may still require manager approval.
					'api.github.com',
					'api.deepseek.com',
					'api.xiaomimimo.com',
					'api.openai.com',
					'enncy.cn',
					'icodef.com',
					'ocsjs.com',
					'zaizhexue.top',
					'localhost',
					'127.0.0.1',
					// 智慧树阿里云资源，应用： 图片题资源访问
					'aliyuncs.com'
				],
				match: matchMetadata,
				grant: [
					'GM_info',
					'GM_getTab',
					'GM_saveTab',
					'GM_setValue',
					'GM_getValue',
					'unsafeWindow',
					'GM_listValues',
					'GM_deleteValue',
					'GM_notification',
					'GM_xmlhttpRequest',
					'GM_getResourceText',
					'GM_addValueChangeListener',
					'GM_removeValueChangeListener'
				],
				require: [path.join(__dirname, distPath, 'index.js')],
				resource: [`STYLE ${CSS_PATH}`],
				'run-at': 'document-start',
				antifeature: 'payment'
			},
			entry: path.join(__dirname, '../packages/scripts/entry.js'),
			dist: path.join(__dirname, distPath, 'ocs.user.js')
		};
	};

	const officialOpts = createOptions();
	console.log('CreateUserScript: ', officialOpts.metadata.name, officialOpts.dist);
	await createUserScript(officialOpts);
	console.log('createMetaFile: ', path.join(distResolvedPath, 'ocs.meta.js'));
	await createMetaFile({ dist: officialOpts.dist, metaDist: path.join(distResolvedPath, 'ocs.meta.js') });

	/** 创建调试脚本 */
	const devOpts = createOptions();
	devOpts.parseRequire = false;
	devOpts.parseResource = false;
	devOpts.metadata.name = devOpts.metadata.name + '(dev)';
	delete devOpts.metadata.updateURL;
	delete devOpts.metadata.downloadURL;
	devOpts.metadata.require = ['file:///' + path.join(distResolvedPath, 'index.js')];
	devOpts.metadata.resource = [`STYLE file:///${CSS_PATH}`];
	devOpts.entry = path.join(__dirname, '../packages/scripts/entry.dev.js');
	devOpts.dist = path.join(distResolvedPath, 'ocs.dev.user.js');
	/** 导出样式文件 */
	fs.copyFileSync(CSS_PATH, path.join(distResolvedPath, 'style.css'));
	console.log('createUserScript: ', devOpts.metadata.name, devOpts.dist);
	await createUserScript(devOpts);
}

exports.default = series(cleanOutput, testResolver, buildPackages, createUserJs);
