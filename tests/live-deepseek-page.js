// Served only by the opt-in local real-API bridge; never contains the API credential.
(async () => {
	const isMiMo = window.LIVE_TEST_VENDOR === 'mimo';
	const providerLabel = isMiMo ? 'MiMo' : 'DeepSeek';
	const providerEndpoint = isMiMo ? 'https://api.xiaomimimo.com/v1' : 'https://api.deepseek.com';
	const extraImage = new URLSearchParams(location.search).get('extra') === 'image';
	const resumeMiMo = isMiMo && new URLSearchParams(location.search).has('resume');
	const onlyJudgement = new URLSearchParams(location.search).get('only') === 'judgement';
	const typedOnly = new URLSearchParams(location.search).has('typed');
	const banner = document.querySelector('#preview-mode');
	banner.textContent = '真实 ' + providerLabel + ' 接口测试 · 仅使用独立测试题';
	document.title = 'OCS Plus · 真实 ' + providerLabel + ' 链路测试';
	document.querySelector('#fixture > h1').textContent = document.title;
	document.querySelector('#fixture > p').textContent =
		'本页调用真实 ' +
		providerLabel +
		'；密钥只留在本地桥接进程内存。更新检查仍返回本地空响应。人工场景会暂停，需在本地试题选择答案并点击 OCS 的人工确认按钮。';
	document.querySelectorAll('#fixture > p').forEach((p, index) => {
		if (index && p.querySelector('button')) p.hidden = true;
	});
	document.querySelector('#image-question').hidden = true;
	const start = document.createElement('button');
	start.textContent = '开始真实链路测试';
	start.id = 'live-start';
	start.style = 'padding:10px 18px;background:#4263eb;color:white;border:0;border-radius:8px';
	if (extraImage) start.textContent = '补充真实图片联合测试';
	const status = document.createElement('p');
	status.id = 'live-status';
	status.textContent = '等待开始；预计 27 次真实 API 请求（含模型列表获取）。';
	if (isMiMo) status.textContent = '预计 MiMo 12 次请求；跨提供商额外使用 DeepSeek 剩余预算 1 次。';
	if (typedOnly) status.textContent = '本轮仅验证新题型规则与 MiMo JSON 模式，最多 9 次真实请求。';
	const table = document.createElement('table');
	table.id = 'live-cases';
	table.style = 'width:100%;font-size:13px';
	table.innerHTML = '<thead><tr><th>场景</th><th>状态</th><th>结果</th></tr></thead><tbody></tbody>';
	const main = document.querySelector('#fixture');
	main.style.maxWidth = '580px';
	main.prepend(start, status, table);
	const output = document.createElement('pre');
	output.id = 'live-final';
	output.style = 'white-space:pre-wrap;font-size:12px';
	main.append(output);
	if (extraImage || resumeMiMo) {
		status.textContent = extraImage
			? '保留此前测试结果；本次仅增加 2 次真实请求。'
			: '复用已验证模型列表，继续剩余场景；保留修复前失败记录。';
		const prior = await fetch('/live/state').then((r) => r.json());
		for (const check of prior.checks) {
			const row = table.querySelector('tbody').insertRow();
			row.insertCell().textContent = check.name;
			row.insertCell().textContent = check.passed ? '通过' : '失败';
			row.insertCell().textContent = check.passed
				? JSON.stringify(check.answer) + ' · ' + check.requestCount + ' 次'
				: check.error;
		}
	}
	const cfg = OCS.CommonProject.scripts.settings.cfg;
	let liveModels = [],
		lastResult;
	const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	async function until(check, ms = 160000) {
		const began = Date.now();
		while (!check()) {
			if (Date.now() - began > ms) throw new Error('本地流程等待超时');
			await pause(100);
		}
	}
	async function postCheck(value) {
		await fetch('/live/checks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Test-Session': window.LIVE_TEST_SESSION },
			body: JSON.stringify(value)
		});
	}
	function setup(spec) {
		const models = liveModels.map((model) => ({
			...model,
			extraBody: isMiMo ? { max_completion_tokens: 1024 } : { max_tokens: 1024, reasoning_effort: 'low' }
		}));
		if (spec.defaultThinking && !isMiMo) models[0].extraBody = { max_tokens: 1024 };
		cfg.aiProviders = [
			{
				id: 'live',
				name: providerLabel + '（真实接口测试）',
				preset: isMiMo ? 'mimo' : 'deepseek',
				endpoint: providerEndpoint,
				timeoutSeconds: 120,
				catalog: [],
				models
			}
		];
		if (spec.peer)
			cfg.aiProviders = [
				...cfg.aiProviders,
				{
					id: 'peer',
					name: 'DeepSeek（独立密钥）',
					preset: 'deepseek',
					endpoint: 'https://api.deepseek.com',
					timeoutSeconds: 120,
					catalog: [],
					models: [
						{
							id: 'deepseek-flash',
							name: 'DeepSeek-V4.1-Flash',
							enabled: true,
							vision: true,
							extraBody: { max_tokens: 1024, reasoning_effort: 'low' }
						}
					]
				}
			];
		cfg.aiEnabled = true;
		cfg.imageOptimize = true;
		cfg.aiAnswerMode = spec.mode || 'advanced';
		cfg.aiSelectedModel = JSON.stringify(['live', liveModels[0].id]);
		cfg.aiModelThreads = (spec.assignments || []).map(([model, threads, source]) => ({
			key: JSON.stringify([source || 'live', model]),
			threads
		}));
		cfg.aiConfidenceEnabled = !!spec.confidence;
		cfg.aiSummaryEnabled = !!spec.summary;
		cfg.aiConsensusThreshold = spec.threshold || 100;
		cfg.aiDecisionRule = spec.rule || 'confidence';
		cfg.aiSummaryModel = spec.summary ? JSON.stringify(['live', spec.summary]) : '';
	}
	function question(spec) {
		const area = document.querySelector('#retry-questions');
		area.replaceChildren();
		const root = document.createElement('section');
		root.dataset.type = spec.type || 'single';
		root.style = 'border:1px solid #cdd5e0;background:white;padding:16px;margin:12px 0;border-radius:10px';
		const title = document.createElement('h3');
		title.textContent = spec.title;
		root.append(title);
		if (spec.image) {
			const canvas = document.createElement('canvas');
			canvas.width = 240;
			canvas.height = 100;
			const ctx = canvas.getContext('2d');
			ctx.fillStyle = 'white';
			ctx.fillRect(0, 0, 240, 100);
			ctx.fillStyle = '#4263eb';
			for (const x of [65, 175]) {
				ctx.beginPath();
				ctx.arc(x, 50, 28, 0, Math.PI * 2);
				ctx.fill();
			}
			const image = document.createElement('img');
			image.src = canvas.toDataURL('image/png');
			image.alt = '独立测试题图';
			title.append(image);
		}
		for (const [index, text] of (spec.options || ['41', '42', '43', '44']).entries()) {
			const wrap = document.createElement('div');
			wrap.setAttribute('aria-checked', 'false');
			const option = document.createElement('div');
			option.className = 'live-option';
			option.style = 'padding:8px;cursor:pointer';
			if (spec.type === 'completion') {
				const input = document.createElement('textarea');
				input.setAttribute('aria-label', '测试填空' + (index + 1));
				option.append(input);
			} else option.textContent = String.fromCharCode(65 + index) + '. ' + text;
			option.onclick = () => {
				if (spec.type === 'completion') return;
				const before = wrap.getAttribute('aria-checked') === 'true';
				if (spec.type !== 'multiple')
					root.querySelectorAll('[aria-checked]').forEach((el) => {
						el.setAttribute('aria-checked', 'false');
						el.style.background = '';
					});
				wrap.setAttribute('aria-checked', String(!before || spec.type !== 'multiple'));
				wrap.style.background = wrap.getAttribute('aria-checked') === 'true' ? '#d6e4ff' : '';
			};
			wrap.append(option);
			root.append(wrap);
		}
		area.append(root);
		return root;
	}
	function actualAnswer(root, spec) {
		return spec.type === 'completion'
			? [...root.querySelectorAll('textarea')].map((input) => input.value)
			: [...root.querySelectorAll('[aria-checked="true"] .live-option')].map((el) => el.textContent.charAt(0)).join('');
	}
	async function run(spec) {
		setup(spec);
		const root = question(spec);
		const rows = table.querySelector('tbody');
		const row = rows.insertRow();
		row.insertCell().textContent = spec.name;
		row.insertCell().textContent = '调用中';
		row.insertCell();
		status.textContent = spec.name + '：调用真实接口中…';
		const before = await fetch('/live/state').then((r) => r.json());
		const began = Date.now();
		let result;
		const results = OCS.CommonProject.scripts.workResults;
		await results.methods.init();
		results.cfg.currentResultIndex = 0;
		const worker = new OCS.OCSWorker({
			root: [root],
			elements: { title: 'h3', options: '.live-option' },
			thread: 1,
			answerer: OCS.createCommonAnswerer({
				period: 0,
				answererWrappers: OCS.CommonProject.scripts.settings.methods.getWorkOptions().answererWrappers,
				titleTransform: (elements) => OCS.extractTextWithImages(elements.title[0]),
				optionsTransform: (elements) => {
					const parts = elements.options.map((el) => OCS.extractTextWithImages(el));
					return { text: parts.map((p) => p.text).join('\n'), images: parts.flatMap((p) => p.images) };
				}
			}),
			work: {
				type: () => spec.type || 'single',
				optionText: (el) => el.textContent,
				handler: (type, answer, option) => {
					if (type === 'completion') {
						const input = option.querySelector('textarea');
						input.value = answer;
						input.dispatchEvent(new Event('input', { bubbles: true }));
					} else option.click();
				}
			},
			onResultsInit: async (_, __, all) => results.methods.fillAll(all.map((item) => OCS.simplifyWorkResult(item))),
			onResultsUpdate: async (current, index) => {
				result = current;
				lastResult = current;
				await results.methods.update(index, OCS.simplifyWorkResult(current));
			}
		});
		OCS.enableSingleQuestionRetry(
			worker,
			OCS.createCXQuestionRetryAdapter({
				layout: 'exam',
				type: () => spec.type || 'single',
				optionText: (el) => el.textContent
			})
		);
		worker.on('start', () => OCS.CommonEvents.emitWorkerStateChange('start'));
		worker.on('done', () => OCS.CommonEvents.emitWorkerStateChange('done'));
		worker.on('close', () => OCS.CommonEvents.emitWorkerStateChange('close'));
		let completed = false;
		const task = worker.doWork().then(() => {
			completed = true;
			worker.emit('done');
		});
		try {
			await until(() => result?.resolved);
			const metadata = result.ctx.searchInfos[0]?.ensemble;
			if (spec.manual) {
				if (metadata?.status !== 'review' || actualAnswer(root, spec)) throw new Error('人工场景被自动填写');
				let uploads = 0;
				worker.uploadHandler({
					results: [result],
					type: 'force',
					callback: () => {
						uploads++;
					}
				});
				if (uploads || completed) throw new Error('人工确认前任务已结束或提交');
				row.cells[1].textContent = '等待人工';
				status.textContent = '人工确认测试：请在左侧本地试题选择 B，再点击 OCS 结果中的“我已人工处理本题”。';
			}
			await task;
			if (spec.retry) {
				const first = actualAnswer(root, spec);
				await result.retry();
				if (JSON.stringify(actualAnswer(root, spec)) !== JSON.stringify(first)) throw new Error('单题重做答案变化');
			}
			const answer = actualAnswer(root, spec);
			if (JSON.stringify(answer) !== JSON.stringify(spec.expected))
				throw new Error('页面结果不符合独立题目预期：' + JSON.stringify(answer));
			const info = result.ctx.searchInfos[0];
			if (spec.expectedStatus && info.ensemble?.status !== spec.expectedStatus)
				throw new Error('决策分支不符：' + info.ensemble?.status);
			const after = await fetch('/live/state').then((r) => r.json());
			const requests = after.records.slice(before.requestCount);
			const report = {
				name: spec.name,
				passed: true,
				type: spec.type || 'single',
				answer,
				decision: info.ensemble?.status || 'single',
				reason: info.ensemble?.reason,
				requestCount: requests.length,
				durationMs: Date.now() - began,
				statuses: requests.map((r) => r.status),
				models: requests.map((r) => r.model),
				reasoningReturned: requests.filter((r) => r.hasReasoning).length,
				summaryCalls: requests.filter((r) => r.summaryReports > 0).length,
				memberErrors: info.ensemble?.members
					.filter((member) => member.error)
					.map((member) => ({ name: member.name, error: member.error }))
			};
			row.cells[1].textContent = '通过';
			row.cells[1].style.color = 'green';
			row.cells[2].textContent = JSON.stringify(answer) + ' · ' + requests.length + ' 次';
			await postCheck(report);
		} catch (error) {
			row.cells[1].textContent = '失败';
			row.cells[1].style.color = 'red';
			row.cells[2].textContent = error.message;
			await postCheck({ name: spec.name, passed: false, error: error.message });
			worker.emit('close');
			throw error;
		} finally {
			worker.emit('close');
		}
	}
	start.onclick = async () => {
		start.disabled = true;
		try {
			status.textContent = '通过 OCS 实际模型发现适配器获取模型…';
			const discovered =
				extraImage || resumeMiMo
					? window.LIVE_TEST_MODELS.map((model) => ({ ...model, vision: model.input_modalities?.includes('image') }))
					: await OCS.listAIModels(providerEndpoint, 'live');
			const flash = discovered.find((model) => model.id === (isMiMo ? 'mimo-v2.6-flash' : 'deepseek-flash'));
			const pro = isMiMo ? flash : discovered.find((model) => model.id === 'deepseek-v4-pro');
			if (!flash || !pro) throw new Error('本轮双模型测试需要 Flash 与 Pro');
			const invalid = 'ocs-plus-intentional-invalid-model';
			if (isMiMo) flash.vision = true; // MiMo's list omits modality metadata; configured from its official image guide.
			liveModels = (
				isMiMo ? [flash] : [flash, pro, { id: invalid, name: '故意无效模型（异常测试）', vision: false }]
			).map((model) => ({
				...model,
				enabled: true,
				vision: !!model.vision,
				extraBody: { max_tokens: 1024, reasoning_effort: 'low' }
			}));
			const base = { title: '计算 17 + 25，选择正确答案。', expected: 'B', confidence: true };
			const f = flash.id,
				p = pro.id;
			const cases = [
				{
					name: '普通单选、字母歧义与单题重做',
					mode: 'basic',
					title: '以下哪个选项的内容是英文字母表中的第一个字母？',
					options: ['B', 'A', 'C', 'D'],
					expected: 'B',
					retry: true,
					defaultThinking: true
				},
				{
					name: '普通多选',
					mode: 'basic',
					type: 'multiple',
					title: '以下哪些数是素数？',
					options: ['2', '4', '3', '9'],
					expected: 'AC'
				},
				{
					name: '普通判断',
					mode: 'basic',
					type: 'judgement',
					title: '判断：2 + 2 = 4。',
					options: ['对', '错'],
					expected: 'A'
				},
				{
					name: '普通双空填空',
					mode: 'basic',
					type: 'completion',
					title: '计算 2 + 3 与 3 × 4，按顺序填入两个空。',
					options: ['', ''],
					expected: ['5', '12']
				},
				...(flash.vision
					? [
							{
								name: '真实图片题',
								mode: 'basic',
								title: '图中有几个实心圆？',
								image: true,
								options: ['1', '2', '3', '4'],
								expected: 'B'
							}
					  ]
					: []),
				{ ...base, name: '单模型三次并发', assignments: [[f, 3]], rule: 'confidence', expectedStatus: 'agreed' },
				{
					...base,
					name: 'Flash 两次 + Pro 一次',
					assignments: [
						[f, 2],
						[p, 1]
					],
					rule: 'confidence',
					expectedStatus: 'agreed'
				},
				{
					...base,
					name: '全人工规则等待与确认',
					assignments: [
						[f, 1],
						[p, 1]
					],
					rule: 'manual',
					confidence: false,
					manual: true,
					expectedStatus: 'confirmed'
				},
				{
					...base,
					name: '一次真实错误导致一致率不足',
					assignments: [
						[f, 1],
						[invalid, 1]
					],
					rule: 'confidence',
					manual: true,
					expectedStatus: 'confirmed'
				},
				{
					...base,
					name: '阈值不足后调用真实总结模型',
					assignments: [
						[f, 1],
						[invalid, 1]
					],
					rule: 'confidence-then-summary',
					summary: f,
					expectedStatus: 'summarized'
				},
				{
					...base,
					name: '真实总结模型优先',
					assignments: [
						[f, 1],
						[p, 1]
					],
					rule: 'summary-then-confidence',
					summary: f,
					expectedStatus: 'summarized'
				},
				{
					...base,
					name: '真实总结失败后回退一致率',
					assignments: [
						[f, 1],
						[p, 1]
					],
					rule: 'summary-then-confidence',
					summary: invalid,
					expectedStatus: 'agreed'
				}
			];
			if (isMiMo)
				cases.splice(
					0,
					cases.length,
					{
						name: 'MiMo 普通单选与字母匹配',
						mode: 'basic',
						title: '以下哪个选项的内容是英文字母表中的第一个字母？',
						options: ['B', 'A', 'C', 'D'],
						expected: 'B'
					},
					{
						name: 'MiMo 普通多选',
						mode: 'basic',
						type: 'multiple',
						title: '以下哪些数是素数？',
						options: ['2', '4', '3', '9'],
						expected: 'AC'
					},
					{
						name: 'MiMo 判断题',
						mode: 'basic',
						type: 'judgement',
						title: '判断：2 + 2 = 4。',
						options: ['对', '错'],
						expected: 'A'
					},
					{
						name: 'MiMo 双空填空',
						mode: 'basic',
						type: 'completion',
						title: '计算 2 + 3 与 3 × 4，按顺序填入两个空。',
						options: ['', ''],
						expected: ['5', '12']
					},
					{
						name: 'MiMo 图片题',
						mode: 'basic',
						title: '图中有几个实心圆？',
						image: true,
						options: ['1', '2', '3', '4'],
						expected: 'B'
					},
					{ ...base, name: 'MiMo 同模型两次并发', assignments: [[f, 2]], rule: 'confidence', expectedStatus: 'agreed' },
					{
						...base,
						name: 'DeepSeek + MiMo 联合，再由 MiMo 总结',
						peer: true,
						assignments: [
							[f, 1],
							['deepseek-flash', 1, 'peer']
						],
						rule: 'summary',
						confidence: false,
						summary: f,
						expectedStatus: 'summarized'
					}
				);
			if (resumeMiMo) cases.splice(0, 2);
			if (onlyJudgement) cases.splice(1);
			if (extraImage)
				cases.splice(0, cases.length, {
					name: '图片题隔离文本模型失败并带图总结',
					title: '图中有几个实心圆？',
					image: true,
					options: ['1', '2', '3', '4'],
					expected: 'B',
					confidence: true,
					assignments: [
						[f, 1],
						[p, 1]
					],
					rule: 'confidence-then-summary',
					summary: f,
					expectedStatus: 'summarized'
				});
			if (typedOnly)
				cases.splice(
					0,
					cases.length,
					{
						name: '网页判断类型、反向选项与引用单选词',
						mode: 'basic',
						type: 'judgement',
						title: '说明文字引用“单选题”，但本题为判断：2 + 2 = 4。',
						options: ['错', '对'],
						expected: 'B'
					},
					{
						name: '网页单选类型与字母歧义',
						mode: 'basic',
						type: 'single',
						title: '题干中引用“判断题”。以下哪个选项内容为英文字母表的第一个字母？',
						options: ['B', 'A', 'C', 'D'],
						expected: 'B'
					},
					{
						name: '网页多选类型与排序字母输出',
						mode: 'basic',
						type: 'multiple',
						title: '以下哪些数是素数？',
						options: ['2', '4', '3', '9'],
						expected: 'AC'
					},
					{
						name: '网页填空类型不被题干中的单选词覆盖',
						mode: 'basic',
						type: 'completion',
						title: '题干引用“单选题”一词。计算 2 + 3 与 3 × 4，按顺序填入两个空。',
						options: ['', ''],
						expected: ['5', '12']
					},
					{
						name: '判断题两次并发再由总结模型核对',
						type: 'judgement',
						title: '判断：2 + 2 = 4。',
						options: ['错', '对'],
						expected: 'B',
						assignments: [[f, 2]],
						summary: f,
						rule: 'summary',
						expectedStatus: 'summarized'
					}
				);
			for (const spec of cases) await run(spec);
			const report = await fetch('/live/state').then((r) => r.json());
			status.textContent =
				'真实链路测试完成：' +
				report.checks.filter((check) => check.passed).length +
				' 个场景通过，共 ' +
				report.requestCount +
				' 次代理记录（跨提供商的转发请求需去重统计）。' +
				(report.checks.some((check) => !check.passed) ? ' 修复前的失败记录保留在下方报告中。' : '');
			output.textContent = JSON.stringify(
				{ requestCount: report.requestCount, peakConcurrency: report.peakConcurrency, checks: report.checks },
				null,
				2
			);
			document.body.dataset.liveResult = 'passed';
		} catch (error) {
			status.textContent = '测试停止：' + error.message;
			document.body.dataset.liveResult = 'failed';
			output.textContent = error.message;
		}
	};
})();
