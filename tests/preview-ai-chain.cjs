// Browser regression fixture: real built OCS modules, simulated AI responses, no credentials.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = require('./preview-ai.cjs').replace('</html>', '<script src="/chain-scenarios.js"></script></html>');
const files = {
	'/chain-scenarios.js': ['tests/preview-ai-chain.js', 'application/javascript'],
	'/dist/index.js': ['dist/index.js', 'application/javascript'],
	'/dist/style.css': ['dist/style.css', 'text/css']
};
http
	.createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (url.pathname === '/') {
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			return res.end(html);
		}
		if (url.pathname === '/question.svg') {
			res.setHeader('Content-Type', 'image/svg+xml');
			return res.end(
				'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="12" fill="blue"/></svg>'
			);
		}
		const file = files[url.pathname];
		if (!file) {
			res.writeHead(404);
			return res.end();
		}
		res.setHeader('Content-Type', file[1] + '; charset=utf-8');
		fs.createReadStream(path.join(root, file[0]))
			.on('error', () => {
				res.statusCode = 404;
				res.end();
			})
			.pipe(res);
	})
	.listen(Number(process.env.PORT || 4187), '127.0.0.1', () =>
		console.log('AI chain scenarios: http://127.0.0.1:' + (process.env.PORT || 4187) + '/?search=1')
	);
