// Local UI fixture. All AI traffic is simulated; no external service or real key is used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>OCS Plus AI 配置验证</title>
<style>body{font:16px system-ui;background:#f1f5f9;padding:32px;color:#16324f}#fixture{max-width:420px;line-height:1.8}li{font-size:13px}</style>
<main id="fixture"><h1>OCS Plus · AI 配置验证</h1><p>右侧是实际脚本设置界面。本页模拟 DeepSeek 的模型列表和答题响应，所有请求均留在本地。请输入任意测试密钥。</p>
<p><button id="failure">切换为 401 错误</button></p><p>请求记录：</p><ol id="requests"></ol></main>
<script>
const values=new Map(), listeners=new Map(); let listenerId=0, tabData={}, fail=false;
if(location.search.includes('legacy=1')){
 values.set('common.settings.aiEndpoint','https://api.deepseek.com/v1');
 values.set('common.settings.aiModel','legacy-model');
 values.set('common.settings.aiModels',[{id:'legacy-model',name:'旧版模型',vision:true}]);
 values.set('common.settings.aiVision',true);
 values.set('ocs.ai.apiKey:https://api.deepseek.com/v1/chat/completions','demo-legacy-key');
}
// Fixture only: expose the shadow DOM to browser automation; the installed script keeps its original closed root.
const nativeAttachShadow=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){return nativeAttachShadow.call(this,{...options,mode:'open'})};
window.unsafeWindow=window;
window.GM_info={script:{name:'OCS Plus 网课助手',version:'5.2.3',namespace:'ocsjs-plus'},scriptHandler:'UI fixture'};
window.GM_getValue=(k,d)=>values.has(k)?values.get(k):d;
window.GM_setValue=(k,v)=>{const old=values.get(k);values.set(k,v);if(JSON.stringify(old)!==JSON.stringify(v))for(const [id,l]of listeners)if(l.k===k)l.f(k,old,v,false)};
window.GM_deleteValue=k=>values.delete(k);window.GM_listValues=()=>[...values.keys()];
window.GM_addValueChangeListener=(k,f)=>{listeners.set(++listenerId,{k,f});return listenerId};window.GM_removeValueChangeListener=id=>listeners.delete(id);
window.GM_getTab=f=>f(tabData);window.GM_saveTab=v=>{tabData=v};window.GM_notification=()=>{};window.GM_getResourceText=()=>'';
document.querySelector('#failure').onclick=()=>{fail=!fail;document.querySelector('#failure').textContent=fail?'恢复正常响应':'切换为 401 错误'};
window.GM_xmlhttpRequest=opts=>{
 const record=document.createElement('li');record.textContent=opts.method+' '+new URL(opts.url).pathname;document.querySelector('#requests').append(record);
 const timer=setTimeout(()=>{
  if(fail){opts.onload({status:401,responseText:'Authentication failed'});return}
  if(opts.method==='GET')opts.onload({status:200,responseText:JSON.stringify({data:[
   {id:'deepseek-flash',name:'DeepSeek Flash',input_modalities:['text','image']},
   {id:'deepseek-v4-pro',name:'DeepSeek Pro',input_modalities:['text']}
  ]})});
  else opts.onload({status:200,responseText:JSON.stringify({choices:[{finish_reason:'stop',message:{reasoning_content:'模拟思考过程',content:JSON.stringify({answers:['2'],uncertain:false})}}]})});
 },100);return{abort(){clearTimeout(timer);opts.onabort?.()}};
};
</script><script src="/dist/index.js"></script><script>
OCS.start({projects:[{name:'通用',scripts:{settings:OCS.CommonProject.scripts.settings,render:OCS.RenderScript}}],renderConfig:{
 renderScript:OCS.RenderScript,styles:[${JSON.stringify(
		fs.readFileSync(path.join(root, 'dist/style.css'), 'utf8')
 )}],defaultPanelName:'common.settings',title:'OCS Plus · AI 设置'
}});
</script><link rel="stylesheet" href="/dist/style.css"></html>`;
http
	.createServer((req, res) => {
		if (new URL(req.url, 'http://127.0.0.1').pathname === '/') {
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.end(html);
			return;
		}
		const files = {
			'/dist/index.js': ['dist/index.js', 'application/javascript'],
			'/dist/style.css': ['dist/style.css', 'text/css']
		};
		const file = files[req.url];
		if (!file) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.setHeader('Content-Type', file[1] + '; charset=utf-8');
		fs.createReadStream(path.join(root, file[0]))
			.on('error', () => {
				res.statusCode = 404;
				res.end('Run npm run build first');
			})
			.pipe(res);
	})
	.listen(4179, '127.0.0.1', () =>
		console.log('AI settings fixture: http://127.0.0.1:4179 (simulated responses only)')
	);
