/* global OCS */
// Every assertion below exercises the built production modules; responses stay in this local fixture.
(() => {
	const area = document.createElement('section');
	area.id = 'chain-scenarios';
	area.innerHTML =
		'<h2>AI 链路修复场景</h2><p>实际构建代码 · 本地模拟响应 · 无真实密钥</p><div id="chain-controls"></div><div id="chain-cases"></div><div id="chain-paper"></div>';
	document.querySelector('#fixture').prepend(area);
	const controls = area.querySelector('#chain-controls');
	const cases = area.querySelector('#chain-cases');
	const paper = area.querySelector('#chain-paper');
	const config = {
		endpoint: 'https://offline.example/v1',
		model: 'fixture',
		vision: true,
		timeoutSeconds: 10,
		authMode: 'none'
	};
	const wrapper = {
		name: '本地测试',
		url: '',
		method: 'post',
		type: 'GM_xmlhttpRequest',
		headers: {},
		handler: '',
		ai: config
	};
	const buttons = [];
	const assert = (condition, message) => {
		if (!condition) throw new Error(message);
	};
	const reply = (request, answers) =>
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers, uncertain: false }) } }]
			})
		});
	let pausedWorker;
	let heldReply;
	let pauseStatus;
	let busy = false;
	function button(name, action) {
		const element = document.createElement('button');
		element.textContent = name;
		element.style = 'margin:4px;padding:6px';
		element.onclick = action;
		controls.append(element);
		return element;
	}
	function scenario(name, action) {
		const element = button(name, async () => {
			if (busy) return;
			busy = true;
			buttons.forEach((button) => {
				button.disabled = true;
			});
			const status = document.createElement('p');
			status.textContent = name + '：运行中';
			cases.append(status);
			const original = window.GM_xmlhttpRequest;
			try {
				await action(status);
				status.textContent = '✓ ' + name + '：通过';
				status.style.color = '#087f5b';
			} catch (error) {
				status.textContent = '✗ ' + name + '：' + error.message;
				status.style.color = '#c92a2a';
			} finally {
				window.GM_xmlhttpRequest = original;
				busy = false;
				buttons.forEach((button) => {
					button.disabled = false;
				});
			}
		});
		buttons.push(element);
	}
	function question(options, type = 'single') {
		const root = document.createElement('section');
		root.innerHTML = '<h3>链路回归题</h3>';
		for (const text of options) {
			const label = document.createElement('label');
			label.style = 'display:block';
			label.innerHTML = '<input type="radio" name="chain-choice">';
			label.append(document.createTextNode(text));
			root.append(label);
		}
		paper.replaceChildren(root);
		return {
			root,
			type,
			elements: { title: [root.querySelector('h3')], options: [...root.querySelectorAll('label')] }
		};
	}
	const answerer = (title, images) =>
		OCS.createCommonAnswerer({
			period: 0,
			answererWrappers: [wrapper],
			titleTransform: () => ({ text: title, images }),
			optionsTransform: (elements) => elements.options.map((element) => element.textContent).join('\n')
		});
	const resolve = (ctx, infos) =>
		OCS.createDefaultQuestionResolver(ctx).single(infos, ctx.elements.options, (_type, _answer, option) => {
			option.querySelector('input').checked = true;
		});
	scenario('重复选项顺序', async () => {
		const ctx = question(['重复内容', '重复内容', '目标答案']);
		window.GM_xmlhttpRequest = (request) => {
			const payload = JSON.parse(JSON.parse(request.data).messages[1].content);
			assert(payload.option_count === 3, '没有网页选项数量');
			const index = payload.options.split('\n').indexOf('目标答案');
			reply(request, [String.fromCharCode(65 + index)]);
		};
		const result = await resolve(ctx, await answerer('选择目标答案')(ctx.elements, ctx));
		assert(result.finish && ctx.elements.options[2].querySelector('input').checked, '选项位置错位');
	});
	scenario('缺图阻止请求及填写', async () => {
		const ctx = question(['甲', '乙']);
		const good = location.origin + '/question.svg';
		const bad = location.origin + '/missing-image.svg';
		let posts = 0;
		window.GM_xmlhttpRequest = (request) => {
			if (request.method === 'GET') return request.onerror({ fixture: true });
			posts++;
			reply(request, ['B']);
		};
		const infos = await answerer('根据两张图判断 ' + good + ' ' + bad, [good, bad])(ctx.elements, ctx);
		const result = await resolve(ctx, infos);
		assert(posts === 0 && !result.finish && /仅成功读取 1 张/.test(infos[0].error), '不完整图片未被阻止');
	});
	scenario('无效总结回退一致答案', async () => {
		window.GM_xmlhttpRequest = (request) => reply(request, [JSON.parse(request.data).model === 'summary' ? 'Z' : 'A']);
		const ctx = question(['甲', '乙']);
		const info = await OCS.searchAIEnsemble(
			{
				models: [config, { ...config, model: 'second' }],
				summary: { ...config, model: 'summary' },
				rule: 'summary-then-confidence',
				threshold: 100
			},
			{ title: '选甲', type: 'single', options: '甲\n乙', option_count: 2 },
			1000
		);
		const result = await resolve(ctx, [info]);
		assert(info.ensemble.status === 'agreed' && info.results[0].answer === 'A' && result.finish, '没有正确回退');
	});
	scenario('主观总结失效不影响客观题', async () => {
		const key = OCS.aiModelKey('fixture', 'fixture');
		const state = {
			selection: key,
			sources: [
				{
					id: 'fixture',
					name: '测试',
					preset: 'openai',
					endpoint: config.endpoint,
					authMode: 'none',
					timeoutSeconds: 10,
					catalog: [],
					models: [{ id: 'fixture', name: '测试', enabled: true, vision: true, extraBody: {} }]
				}
			]
		};
		const wrappers = OCS.createAIAnswererWrappers(state, true, [{ key, threads: 2 }], {
			rule: 'confidence',
			confidenceEnabled: true,
			threshold: 100,
			summaryEnabled: true,
			summarySelection: OCS.aiModelKey('removed', 'summary'),
			subjectiveRule: 'summary'
		});
		let calls = 0;
		window.GM_xmlhttpRequest = (request) => {
			calls++;
			reply(request, ['A']);
		};
		const infos = await OCS.defaultAnswerWrapperHandler(wrappers, {
			title: '选甲',
			type: 'single',
			options: '甲\n乙',
			option_count: 2
		});
		assert(calls === 2 && infos[0].ensemble.status === 'agreed', '另一题型仍被阻断');
	});
	scenario('请求中暂停与继续', async (status) => {
		const ctx = question(['甲', '乙']);
		pauseStatus = status;
		window.GM_xmlhttpRequest = (request) => {
			heldReply = () => reply(request, ['B']);
			status.textContent = '响应等待中：请依次点“暂停”“返回响应”“继续”';
		};
		pausedWorker = new OCS.OCSWorker({
			root: [ctx.root],
			elements: { title: 'h3', options: 'label' },
			thread: 1,
			answerer: answerer('暂停测试题'),
			work: {
				type: () => 'single',
				handler: (_type, _answer, option) => {
					option.querySelector('input').checked = true;
				}
			}
		});
		await pausedWorker.doWork();
		assert(ctx.elements.options[1].querySelector('input').checked, '继续后未填入');
		pausedWorker = undefined;
		heldReply = undefined;
	});
	button('暂停', () => {
		if (pausedWorker) {
			pausedWorker.emit('stop');
			pauseStatus.textContent = '已暂停：可以返回模拟响应，原题应保持未选中';
		}
	});
	button('返回响应', () => {
		if (heldReply) {
			heldReply();
			heldReply = undefined;
			pauseStatus.textContent = '响应已返回，仍暂停：原题保持未选中，等待继续';
		}
	});
	button('继续', () => {
		if (pausedWorker) pausedWorker.emit('continuate');
	});
})();
