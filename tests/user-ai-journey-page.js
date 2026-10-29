// Local user-journey paper. Configuration is performed through the actual OCS UI.
// Credentials remain in the two bridge processes; the page stores dummy UI tokens only.
(() => {
	document.title = 'OCS Plus · 用户操作真实接口验收';
	document.querySelector('#preview-mode').textContent = '真实 DeepSeek / MiMo 接口 · 本地独立试题 · 不提交课程';
	const fixture = document.querySelector('#fixture');
	fixture.style.maxWidth = '600px';
	fixture.replaceChildren();
	const heading = document.createElement('h1');
	heading.textContent = document.title;
	const intro = document.createElement('p');
	intro.textContent =
		'先在 OCS 全局设置里添加提供商、模型和模式，再在这里开始本地试题。API Key 输入 ui-live-key 表示使用已授权的临时真实密钥；输入 ui-invalid-key 仅用于真实 401 失败恢复测试。此页面不接触课程提交。';
	const select = document.createElement('select');
	select.setAttribute('aria-label', '本地试题场景');
	for (const [value, label] of [
		['single', '文字单选'],
		['multiple', '文字多选'],
		['judgement', '反向选项判断题'],
		['completion', '双空填空'],
		['image', '真实图片题'],
		['two', '双题卷与单题重做']
	]) {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = label;
		select.append(option);
	}
	const start = document.createElement('button');
	start.textContent = '开始本地试题';
	const stop = document.createElement('button');
	stop.textContent = '关闭本次任务';
	stop.disabled = true;
	const status = document.createElement('p');
	status.id = 'journey-status';
	status.textContent = '等待通过实际设置界面配置。';
	const paper = document.createElement('section');
	paper.id = 'journey-paper';
	const history = document.createElement('ol');
	history.id = 'journey-history';
	const stats = document.createElement('pre');
	stats.id = 'journey-stats';
	stats.style = 'font-size:12px;white-space:pre-wrap';
	fixture.append(heading, intro, select, start, stop, status, paper, document.createElement('hr'), history, stats);
	const definitions = {
		single: {
			type: 'single',
			title: '以下哪个选项的内容是英文字母表的第一个字母？',
			options: ['B', 'A', 'C', 'D'],
			expected: 'B'
		},
		multiple: { type: 'multiple', title: '以下哪些数是素数？', options: ['2', '4', '3', '9'], expected: 'AC' },
		judgement: { type: 'judgement', title: '判断：2 + 2 = 4。', options: ['错', '对'], expected: 'B' },
		completion: {
			type: 'completion',
			title: '计算 2 + 3 与 3 × 4，按顺序填入两个空。',
			options: ['', ''],
			expected: ['5', '12']
		},
		image: { type: 'single', title: '图中有几个实心圆？', options: ['1', '2', '3', '4'], expected: 'B', image: true }
	};
	let worker,
		activeDefinitions = [];
	function buildQuestion(spec, index) {
		const root = document.createElement('section');
		root.dataset.type = spec.type;
		root.style = 'background:white;padding:16px;margin:14px 0;border:1px solid #cbd5e1;border-radius:12px';
		const title = document.createElement('h3');
		title.textContent = index + 1 + '. ' + spec.title;
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
			image.alt = '本地试题图片';
			title.append(image);
		}
		for (const [i, text] of spec.options.entries()) {
			const wrapper = document.createElement('div');
			wrapper.setAttribute('aria-checked', 'false');
			const option = document.createElement('div');
			option.className = 'journey-option';
			option.style = 'padding:8px;cursor:pointer';
			if (spec.type === 'completion') {
				const input = document.createElement('textarea');
				input.setAttribute('aria-label', '第' + (index + 1) + '题第' + (i + 1) + '空');
				option.append(input);
			} else option.textContent = String.fromCharCode(65 + i) + '. ' + text;
			option.onclick = () => {
				if (spec.type === 'completion') return;
				const selected = wrapper.getAttribute('aria-checked') === 'true';
				if (spec.type !== 'multiple')
					for (const other of root.querySelectorAll('[aria-checked]')) {
						other.setAttribute('aria-checked', 'false');
						other.style.background = '';
					}
				wrapper.setAttribute('aria-checked', String(!selected || spec.type !== 'multiple'));
				wrapper.style.background = wrapper.getAttribute('aria-checked') === 'true' ? '#d6e4ff' : '';
			};
			wrapper.append(option);
			root.append(wrapper);
		}
		return root;
	}
	function answer(root, spec) {
		return spec.type === 'completion'
			? [...root.querySelectorAll('textarea')].map((input) => input.value)
			: [...root.querySelectorAll('[aria-checked="true"] .journey-option')]
					.map((option) => option.textContent.charAt(0))
					.join('');
	}
	stop.onclick = () => {
		worker?.emit('close');
		status.textContent = '本次任务已关闭。';
		stop.disabled = true;
		start.disabled = false;
	};
	start.onclick = async () => {
		if (worker?.isRunning) return;
		const options = OCS.CommonProject.scripts.settings.methods.getWorkOptions();
		if (!options.answererWrappers.length) {
			status.textContent = '尚未配置有效答题模型，请先在 OCS 设置中添加并选择。';
			return;
		}
		worker?.emit('close');
		start.disabled = true;
		stop.disabled = false;
		status.textContent = '正在通过真实接口作答…';
		paper.replaceChildren();
		activeDefinitions =
			select.value === 'two' ? [definitions.single, definitions.judgement] : [definitions[select.value]];
		activeDefinitions.forEach((spec, index) => paper.append(buildQuestion(spec, index)));
		const results = OCS.CommonProject.scripts.workResults;
		await results.methods.init();
		results.cfg.currentResultIndex = 0;
		worker = new OCS.OCSWorker({
			root: [...paper.children],
			elements: { title: 'h3', options: '.journey-option' },
			thread: 1,
			answerer: OCS.createCommonAnswerer({
				period: 0,
				answererWrappers: options.answererWrappers,
				titleTransform: (elements) => OCS.extractTextWithImages(elements.title[0]),
				optionsTransform: (elements) => {
					const items = elements.options.map((option) => OCS.extractTextWithImages(option));
					return { text: items.map((item) => item.text).join('\n'), images: items.flatMap((item) => item.images) };
				}
			}),
			work: {
				type: (ctx) => ctx.root.dataset.type,
				optionText: (option) => option.textContent,
				handler: (type, value, option) => {
					if (type === 'completion') {
						const input = option.querySelector('textarea');
						input.value = value;
						input.dispatchEvent(new Event('input', { bubbles: true }));
					} else option.click();
				}
			},
			onResultsInit: async (_, __, all) => results.methods.fillAll(all.map((result) => OCS.simplifyWorkResult(result))),
			onResultsUpdate: async (current, index) => {
				await results.methods.update(index, OCS.simplifyWorkResult(current));
				if (
					current.resolved &&
					current.result?.finish === false &&
					current.ctx?.searchInfos.some((info) => info.ensemble?.status === 'review')
				)
					status.textContent = '等待人工评判：在本地原题选择后，点击 OCS 的“我已人工处理本题”。';
			}
		});
		OCS.enableSingleQuestionRetry(
			worker,
			OCS.createCXQuestionRetryAdapter({
				layout: 'exam',
				type: (ctx) => ctx.root.dataset.type,
				optionText: (option) => option.textContent
			})
		);
		worker.on('start', () => OCS.CommonEvents.emitWorkerStateChange('start'));
		worker.on('done', () => OCS.CommonEvents.emitWorkerStateChange('done'));
		worker.on('close', () => OCS.CommonEvents.emitWorkerStateChange('close'));
		try {
			await worker.doWork();
			if (worker.isClose) return;
			worker.emit('done');
			const actual = [...paper.children].map((root, index) => answer(root, activeDefinitions[index]));
			const expected = activeDefinitions.map((spec) => spec.expected);
			const passed = JSON.stringify(actual) === JSON.stringify(expected);
			status.textContent =
				'本地试题结束：页面答案 ' +
				JSON.stringify(actual) +
				'；' +
				(passed ? '与已知答案相符。' : '未填写或与已知答案不同，请检查结果。');
			const line = document.createElement('li');
			line.textContent =
				select.options[select.selectedIndex].textContent +
				' / ' +
				OCS.CommonProject.scripts.settings.cfg.aiAnswerMode +
				' / ' +
				JSON.stringify(actual);
			history.append(line);
		} catch (error) {
			status.textContent = '任务错误：' + error.message;
		} finally {
			start.disabled = false;
			stop.disabled = true;
		}
	};
	const refresh = async () => {
		try {
			const state = await fetch('/live/state').then((response) => response.json());
			stats.textContent =
				'本地桥接记录：' +
				state.requestCount +
				' / ' +
				state.requestLimit +
				'（含转发）\n' +
				state.records
					.map(
						(record) =>
							record.id +
							' ' +
							record.method +
							' ' +
							record.provider +
							' ' +
							(record.model || '') +
							' HTTP ' +
							(record.status || '进行中')
					)
					.join('\n');
		} catch {}
	};
	refresh();
	setInterval(refresh, 2000);
})();
