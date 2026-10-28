// Local UI fixture. All AI traffic is simulated; no external service or real key is used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>OCS Plus · 本地模拟预览</title>
<style>body{font:16px system-ui;background:#f1f5f9;padding:32px;color:#16324f}#fixture{max-width:420px;line-height:1.8}li{font-size:13px}#preview-mode{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:6px 16px;border-radius:8px;background:#fff1cb;color:#795107;border:1px solid #e0ba60;font:13px system-ui;pointer-events:none;white-space:nowrap}</style>
<div id="preview-mode" role="note">本地模拟预览 · AI 与更新响应均为模拟 · 请勿填写真实密钥</div>
<main id="fixture"><h1>OCS Plus · 本地模拟预览</h1><p>右侧是实际脚本设置界面。模型列表按供应商地址分别模拟，示例模型不代表真实可用模型；所有请求均留在本地，仅用于验证交互流程。</p>
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
 const endpoint=new URL(opts.url);
 const record=document.createElement('li');record.textContent=opts.method+' '+endpoint.host+endpoint.pathname;document.querySelector('#requests').append(record);
 const catalogs={
  'api.deepseek.com':[
   {id:'deepseek-flash',name:'DeepSeek Flash（模拟）',input_modalities:['text','image']},
   {id:'deepseek-v4-pro',name:'DeepSeek Pro（模拟）',input_modalities:['text']}
  ],
  'api.xiaomimimo.com':[
   {id:'mimo-demo-text',name:'MiMo 示例文字模型（模拟）',input_modalities:['text']},
   {id:'mimo-demo-vision',name:'MiMo 示例图片模型（模拟）',input_modalities:['text','image']}
  ],
  'api.openai.com':[
   {id:'openai-demo-text',name:'OpenAI 示例文字模型（模拟）',input_modalities:['text']},
   {id:'openai-demo-vision',name:'OpenAI 示例图片模型（模拟）',input_modalities:['text','image']}
  ]
 };
 const catalog=catalogs[endpoint.hostname]||[{id:'custom-demo-model',name:'自定义示例模型（模拟）',input_modalities:['text']}];
 const timer=setTimeout(()=>{
  if(endpoint.hostname==='api.github.com'){
   const mode=new URLSearchParams(location.search).get('updates')||'none';
   if(mode==='error'){opts.onload({status:403,responseText:'rate limit'});return}
   if(mode==='none'){opts.onload({status:404,responseText:'Not Found'});return}
   const base='https://github.com/${
			require('../packages/scripts/src/config/plus-repository.json').repository
		}/releases/download/v5.3.0/';
   opts.onload({status:200,responseText:JSON.stringify({tag_name:'v5.3.0',draft:false,prerelease:false,
    body:'## 模拟更新说明\\n\\n- 验证 OCS Plus 仓库更新界面\\n- 此版本仅用于本地模拟，不是实际发布',
    assets:mode==='pending'?[]:['ocs.user.js','ocs.meta.js'].map(name=>({name,state:'uploaded',size:100,browser_download_url:base+name}))})});return;
  }
  if(fail){opts.onload({status:401,responseText:'Authentication failed'});return}
  if(opts.method==='GET')opts.onload({status:200,responseText:JSON.stringify({data:catalog})});
  else opts.onload({status:200,responseText:JSON.stringify({choices:[{finish_reason:'stop',message:{reasoning_content:'模拟思考过程',content:JSON.stringify({answers:['2'],uncertain:false})}}]})});
 },100);return{abort(){clearTimeout(timer);opts.onabort?.()}};
};
</script><script src="/dist/index.js"></script><script>
OCS.start({projects:[{name:'通用',scripts:{settings:OCS.CommonProject.scripts.settings,update:OCS.BackgroundProject.scripts.update,render:OCS.RenderScript}}],renderConfig:{
 renderScript:OCS.RenderScript,styles:[${JSON.stringify(
		fs.readFileSync(path.join(root, 'dist/style.css'), 'utf8')
 )}],defaultPanelName:location.search.includes('updates=')?'background.update':'common.settings',title:'OCS Plus · 本地模拟预览'
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
			'/dist/ocs.user.js': ['dist/ocs.user.js', 'application/javascript'],
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
