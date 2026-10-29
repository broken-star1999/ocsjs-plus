// Opt-in real API test bridge. The credential is read once from stdin and stays in memory.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const root = path.resolve(__dirname, '..');
const vendor = process.env.LIVE_VENDOR || 'deepseek';
const userJourney = process.env.LIVE_UI_JOURNEY === '1';
const apiBase = vendor === 'mimo' ? 'https://api.xiaomimimo.com/v1' : 'https://api.deepseek.com';
const requestLimit = Number(process.env.LIVE_REQUEST_LIMIT || (vendor === 'mimo' ? 14 : 30));
if (!Number.isInteger(requestLimit) || requestLimit < 1 || requestLimit > 30)
	throw new Error('Invalid live request limit');
let peerSession;
const port = Number(process.env.PORT || 4182);
const origin = `http://127.0.0.1:${port}`;
const session = crypto.randomBytes(24).toString('hex');
const records = [];
let credential = '',
	active = 0,
	peak = 0,
	catalog = [],
	checks = [];
const redact = (text) => (credential ? String(text).split(credential).join('[REDACTED]') : String(text));
const state = () => ({
	startedAt,
	requestLimit,
	vendor,
	requestCount: records.length,
	peakConcurrency: peak,
	models: catalog,
	records,
	checks
});
const startedAt = new Date().toISOString();
async function call(url, method, data, invalidCredential = false) {
	const target = new URL(url);
	if (
		![new URL(apiBase).origin, ...(vendor === 'mimo' ? ['https://api.deepseek.com'] : [])].includes(target.origin) ||
		!['/models', '/v1/models', '/chat/completions', '/v1/chat/completions'].includes(target.pathname) ||
		target.search ||
		target.hash
	)
		throw new Error('Only the configured official API is allowed');
	if (!['GET', 'POST'].includes(method) || (method === 'POST') !== target.pathname.endsWith('/chat/completions'))
		throw new Error('Invalid API method');
	if (records.length >= requestLimit) throw new Error('Hard real-request limit reached');
	const body = data ? JSON.parse(data) : undefined;
	const text = body?.messages?.[1]?.content;
	let payload;
	try {
		payload = JSON.parse(Array.isArray(text) ? text[0].text : text);
	} catch {}
	const record = {
		id: records.length + 1,
		method,
		provider: target.hostname,
		path: target.pathname,
		model: body?.model,
		questionType: payload?.type,
		responseFormat: body?.response_format?.type,
		...(invalidCredential ? { invalidCredential: true } : {}),
		imageCount: Array.isArray(text) ? text.filter((p) => p.type === 'image_url').length : 0,
		summaryReports: payload?.model_reports?.length || 0,
		startedAt: new Date().toISOString()
	};
	records.push(record);
	active++;
	peak = Math.max(peak, active);
	const began = Date.now();
	try {
		let status, responseText;
		if (vendor === 'mimo' && target.hostname === 'api.deepseek.com') {
			if (!peerSession) {
				const bridge = await fetch('http://127.0.0.1:4182/live-bootstrap.js').then((response) => response.text());
				const match = bridge.match(/'X-Test-Session':\s*("[^"\n]+")/);
				if (!match) throw new Error('Peer test bridge is unavailable');
				peerSession = JSON.parse(match[1]);
			}
			const result = await fetch('http://127.0.0.1:4182/live/relay', {
				method: 'POST',
				headers: { Origin: 'http://127.0.0.1:4182', 'Content-Type': 'application/json', 'X-Test-Session': peerSession },
				body: JSON.stringify({ url, method, data, invalidCredential })
			}).then((response) => response.json());
			if (result.error) throw new Error(result.error);
			status = result.status;
			responseText = result.responseText;
			record.routedViaPeer = true;
		} else {
			const response = await fetch(target, {
				method,
				headers: {
					Authorization: 'Bearer ' + (invalidCredential ? 'invalid-local-ui-test-key' : credential),
					'Content-Type': 'application/json'
				},
				...(data ? { body: data } : {}),
				redirect: 'error',
				signal: AbortSignal.timeout(150000)
			});
			status = response.status;
			responseText = redact(await response.text());
		}
		record.status = status;
		let value;
		try {
			value = JSON.parse(responseText);
		} catch {}
		record.usage = value?.usage;
		record.finishReason = value?.choices?.[0]?.finish_reason;
		record.hasReasoning = !!value?.choices?.[0]?.message?.reasoning_content;
		record.reasoningLength = value?.choices?.[0]?.message?.reasoning_content?.length || 0;
		try {
			const answers = JSON.parse(value?.choices?.[0]?.message?.content).answers;
			if (Array.isArray(answers))
				record.returnedAnswers = answers.map((answer) => redact(String(answer)).slice(0, 200));
		} catch {}
		console.log(
			JSON.stringify({
				id: record.id,
				status: record.status,
				model: record.model,
				durationMs: Date.now() - began,
				summaryReports: record.summaryReports
			})
		);
		return { status, responseText };
	} catch (error) {
		record.error = redact(error.message);
		throw new Error(record.error);
	} finally {
		active--;
		record.durationMs = Date.now() - began;
	}
}
function bootstrap() {
	const setup = userJourney
		? `
const uiStateKey='ocs.live-ui-config';const uiValues=new Map(JSON.parse(sessionStorage.getItem(uiStateKey)||'[]'));
const uiSet=GM_setValue;const uiDelete=GM_deleteValue;
for(const [key,value] of uiValues)uiSet(key,value);
window.GM_setValue=(key,value)=>{uiSet(key,value);uiValues.set(key,value);sessionStorage.setItem(uiStateKey,JSON.stringify([...uiValues]));};
window.GM_deleteValue=key=>{uiDelete(key);uiValues.delete(key);sessionStorage.setItem(uiStateKey,JSON.stringify([...uiValues]));};
if(!uiValues.has('common.settings.aiProviders')){
 GM_setValue('common.settings.aiProvidersMigrated',true);GM_setValue('common.settings.aiProviders',[]);
 GM_setValue('common.settings.imageOptimize',true);GM_setValue('common.settings.aiAnswerMode','basic');GM_setValue('common.settings.aiEnabled',true);
}
`
		: `
const liveCopy=GM_getValue;window.GM_getValue=(key,fallback)=>key.startsWith('ocs.ai.apiKey')?'live-memory-only':liveCopy(key,fallback);
GM_setValue('common.settings.aiProvidersMigrated',true);GM_setValue('common.settings.imageOptimize',true);
GM_setValue('common.settings.aiProviders',[{id:'live',name:'真实接口测试',preset:${JSON.stringify(
				vendor
		  )},endpoint:${JSON.stringify(apiBase)},timeoutSeconds:120,catalog:[],models:[]}]);
GM_setValue('common.settings.aiAnswerMode','basic');GM_setValue('common.settings.aiEnabled',true);
`;
	return `window.LIVE_TEST_MODELS=${JSON.stringify(catalog)};window.LIVE_TEST_VENDOR=${JSON.stringify(
		vendor
	)};window.LIVE_TEST_ENDPOINT=${JSON.stringify(apiBase)};
${setup}
window.GM_xmlhttpRequest=opts=>{
 const endpoint=new URL(opts.url);const controller=new AbortController();let timedOut=false;
 if(endpoint.hostname==='api.github.com'){queueMicrotask(()=>opts.onload({status:404,responseText:'Not Found'}));return{abort(){}}}
 if(!${JSON.stringify([
		new URL(apiBase).origin,
		...(vendor === 'mimo' ? ['https://api.deepseek.com'] : [])
 ])}.includes(endpoint.origin)){queueMicrotask(()=>opts.onerror?.({}));return{abort(){}}}
 const timer=setTimeout(()=>{timedOut=true;controller.abort();opts.ontimeout?.()},opts.timeout||120000);
 fetch('/live/relay',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Session':${JSON.stringify(
		session
 )}},body:JSON.stringify({url:opts.url,method:opts.method,data:opts.data,invalidCredential:opts.headers?.Authorization==='Bearer ui-invalid-key'}),signal:controller.signal})
 .then(r=>r.json()).then(value=>{clearTimeout(timer);if(value.error)opts.onerror?.({});else opts.onload(value)})
 .catch(()=>{clearTimeout(timer);if(!timedOut)opts.onerror?.({})});
 return{abort(){clearTimeout(timer);controller.abort();opts.onabort?.()}};
};`;
}
async function body(req) {
	let data = '';
	for await (const chunk of req) {
		data += chunk;
		if (data.length > 2000000) throw new Error('Payload too large');
	}
	return JSON.parse(data || '{}');
}
async function start() {
	const discovery = await call(apiBase + '/models', 'GET');
	if (discovery.status !== 200) throw new Error('Model discovery HTTP ' + discovery.status);
	catalog = JSON.parse(discovery.responseText).data.map((model) => ({
		id: model.id,
		name: model.name || model.id,
		input_modalities: model.input_modalities,
		effort: model.effort
	}));
	console.log(JSON.stringify({ models: catalog }));
	const server = http.createServer(async (req, res) => {
		try {
			const pathname = new URL(req.url, origin).pathname;
			if (req.method === 'POST') {
				if (req.headers.origin !== origin || req.headers['x-test-session'] !== session) {
					res.writeHead(403);
					res.end();
					return;
				}
				const value = await body(req);
				if (pathname === '/live/relay') {
					res.setHeader('Content-Type', 'application/json');
					res.end(JSON.stringify(await call(value.url, value.method, value.data, value.invalidCredential === true)));
					return;
				}
				if (pathname === '/live/checks') {
					checks.push(value);
					res.setHeader('Content-Type', 'application/json');
					res.end('{}');
					return;
				}
			}
			if (pathname === '/live/state') {
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify(state()));
				return;
			}
			if (pathname === '/live-bootstrap.js') {
				res.setHeader('Content-Type', 'application/javascript');
				res.end(bootstrap());
				return;
			}
			if (pathname === '/live-page.js') {
				res.setHeader('Content-Type', 'application/javascript');
				res.end(
					fs.readFileSync(path.join(__dirname, userJourney ? 'user-ai-journey-page.js' : 'live-deepseek-page.js'))
				);
				return;
			}
			if (pathname === '/') {
				let html = require('./preview-ai.cjs');
				html = html.replace(
					'<script src="/dist/index.js">',
					'<script src="/live-bootstrap.js"></script><script src="/dist/index.js">'
				);
				html = html.replace(
					'</html>',
					`<script>window.LIVE_TEST_SESSION=${JSON.stringify(
						session
					)}</script><script src="/live-page.js"></script></html>`
				);
				res.setHeader('Content-Type', 'text/html;charset=utf-8');
				res.end(html);
				return;
			}
			if (pathname.startsWith('/dist/')) {
				const file = path.resolve(root, '.' + pathname);
				if (!file.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('Invalid path');
				res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'application/javascript');
				res.end(fs.readFileSync(file));
				return;
			}
			res.writeHead(404);
			res.end();
		} catch (error) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: redact(error.message) }));
		}
	});
	server.listen(port, '127.0.0.1', () =>
		console.log('LIVE TEST READY ' + origin + ' (' + requestLimit + ' records maximum; official ' + vendor + ')')
	);
	process.on('SIGINT', () => {
		credential = '';
		server.close(() => process.exit());
	});
}
console.log('Waiting for test credential on standard input (not echoed).');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.once('line', (line) => {
	credential = line.trim();
	input.close();
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	start().catch((error) => {
		console.error(redact(error.message));
		credential = '';
		process.exitCode = 1;
	});
});
