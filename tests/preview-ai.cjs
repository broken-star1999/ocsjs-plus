// Local UI fixture. All AI traffic is simulated; no external service or real key is used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>OCS Plus · 本地模拟预览</title>
<style>body{font:16px system-ui;background:#f1f5f9;padding:32px;color:#16324f}#fixture{max-width:420px;line-height:1.8}li{font-size:13px}#preview-mode{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:6px 16px;border-radius:8px;background:#fff1cb;color:#795107;border:1px solid #e0ba60;font:13px system-ui;pointer-events:none;white-space:nowrap}</style>
<div id="preview-mode" role="note">本地模拟预览 · AI 与更新响应均为模拟 · 请勿填写真实密钥</div>
<main id="fixture"><h1>OCS Plus · 本地模拟预览</h1><p>右侧是实际脚本设置界面。模型列表按供应商地址分别模拟，示例模型不代表真实可用模型；所有请求均留在本地，仅用于验证交互流程。</p>
<p><button id="failure">切换为 401 错误</button></p>
<section id="image-question"><p>图中有几个圆？请选择正确答案。</p><img width="140" height="70" src="/question.svg" alt="示例题图"><p>A. 1 个</p><p>B. 2 个</p></section>
<p><button id="select-image">只选示例图片</button> <button id="select-question">选中整道示例题</button></p>
<p><button id="layout-example">五图长题示例</button></p>
<p><button id="add-frame">加载测试子页面</button> <button id="child-call">发起子页面模拟请求</button></p>
<p><button id="auto-results">生成自动搜题示例</button></p>
<p><button id="retry-example">加载单题重做测试</button></p><section id="retry-questions"></section>
<p>请求记录：</p><ol id="requests"></ol></main>
<script>
const values=new Map(), listeners=new Map(), retryCalls=new Map(); let listenerId=0, tabData={}, fail=false;
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
window.GM_info={script:{name:'OCS Plus 网课助手',version:'${
	require('../package.json').version
}',namespace:'ocsjs-plus'},scriptHandler:'UI fixture'};
if(location.search.includes('search=1')||location.search.includes('results=1')||location.search.includes('ensemble=1')){
 values.set('common.settings.aiProvidersMigrated',true);
 values.set('common.settings.imageOptimize',true);
 values.set('common.settings.aiProviders',[{id:'fixture',name:'DeepSeek（本地模拟）',preset:'deepseek',endpoint:'https://api.deepseek.com',timeoutSeconds:120,catalog:[],models:[{id:'fixture-vision',name:'模拟识图模型',enabled:true,vision:true,extraBody:{}}]}]);
 values.set('common.settings.aiSelectedModel',JSON.stringify(['fixture','fixture-vision']));
}
if(location.search.includes('ensemble=1')){
 const sources=values.get('common.settings.aiProviders');sources[0].models.push(
 {id:'fixture-second',name:'第二模拟模型',enabled:true,vision:true,extraBody:{}},
 {id:'fixture-summary',name:'模拟总结模型',enabled:true,vision:true,extraBody:{}});
 values.set('common.settings.aiAnswerMode','advanced');
 values.set('common.settings.aiModelThreads',[{key:JSON.stringify(['fixture','fixture-vision']),threads:3},{key:JSON.stringify(['fixture','fixture-second']),threads:1}]);
 values.set('common.settings.aiConfidenceEnabled',true);values.set('common.settings.aiConsensusThreshold',75);
 values.set('common.settings.aiDecisionRule','confidence');values.set('common.settings.aiSummaryModel',JSON.stringify(['fixture','fixture-summary']));
 if(location.search.includes('review=1'))values.set('common.settings.aiConsensusThreshold',100);
 if(location.search.includes('summary=1')){values.set('common.settings.aiConsensusThreshold',100);values.set('common.settings.aiSummaryEnabled',true);values.set('common.settings.aiDecisionRule','confidence-then-summary')}
}
const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
window.GM_getValue=(k,d)=>copy(values.has(k)?values.get(k):d);
window.GM_setValue=(k,v,remote=false)=>{const old=values.get(k);values.set(k,copy(v));if(JSON.stringify(old)!==JSON.stringify(v))for(const [id,l]of listeners)if(l.k===k)l.f(k,copy(old),copy(v),remote)};
window.GM_deleteValue=k=>values.delete(k);window.GM_listValues=()=>[...values.keys()];
window.GM_addValueChangeListener=(k,f)=>{listeners.set(++listenerId,{k,f});return listenerId};window.GM_removeValueChangeListener=id=>listeners.delete(id);
window.GM_getTab=f=>f(copy(tabData));window.GM_saveTab=v=>{tabData=copy(v)};window.GM_notification=()=>{};window.GM_getResourceText=()=>'';
if(self!==top)for(const name of ['GM_getValue','GM_setValue','GM_deleteValue','GM_listValues','GM_addValueChangeListener','GM_removeValueChangeListener','GM_getTab','GM_saveTab'])window[name]=top[name];
if(self!==top)window.GM_setValue=(k,v)=>top.GM_setValue(k,v,true);
document.querySelector('#failure').onclick=()=>{fail=!fail;document.querySelector('#failure').textContent=fail?'恢复正常响应':'切换为 401 错误'};
const selectExample=imageOnly=>{
 const range=document.createRange();const target=document.querySelector(imageOnly?'#image-question img':'#image-question');
 if(imageOnly)range.selectNode(target);else range.selectNodeContents(target);
 const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
};
document.querySelector('#select-image').onclick=()=>selectExample(true);
document.querySelector('#select-question').onclick=()=>selectExample(false);
document.querySelector('#layout-example').onclick=()=>{
 const question=document.querySelector('#image-question');
 question.style='max-height:240px;overflow:auto';
 question.replaceChildren();
 const title=document.createElement('p');title.textContent='长题干示例：给定曲面与平面，判断投影方程。'.repeat(8)+'x'.repeat(240);question.append(title);
 for(let i=1;i<=5;i++){
  const line=document.createElement('p');line.textContent=i===1?'题图':String.fromCharCode(63+i)+'.';
  const image=document.createElement('img');image.src='/question.svg?image='+i;image.width=140;image.height=70;
  line.append(image);question.append(line);
 }
 selectExample(false);
};
document.querySelector('#add-frame').onclick=()=>{
 if(document.querySelector('#test-child'))return;
 const iframe=document.createElement('iframe');iframe.id='test-child';iframe.title='测试子页面';
 iframe.src='/?search=1&child=1';iframe.style='width:460px;height:340px';document.querySelector('#fixture').append(iframe);
};
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
  else {
   const request=JSON.parse(opts.data);const parts=request.messages[1].content;
   const payload=JSON.parse(Array.isArray(parts)?parts[0].text:parts);
   record.textContent+=' · 图片 '+(Array.isArray(parts)?parts.filter(p=>p.type==='image_url').length:0)+' 张';
   if(payload.question.includes('接口失败示例')){opts.onload({status:401,responseText:'Authentication failed'});return}
   const uncertain=payload.question.includes('不确定示例');
   let answer=['2'];
   if(payload.question.startsWith('单题重做模拟')){
    const count=retryCalls.get(payload.question)||0;retryCalls.set(payload.question,count+1);
    answer=payload.question.includes('多选')?(count?['BD']:['AC']):payload.question.includes('判断')?(count?['错误']:['正确']):payload.question.includes('填空')?(count?['新甲','新乙']:['旧甲','旧乙']):(count?['D']:['A']);
    if(location.search.includes('ensemble=1')){
     const second=request.model==='fixture-second',summary=request.model==='fixture-summary';
     answer=payload.question.includes('多选')?(summary?['AD']:second?['BD']:['AC']):payload.question.includes('判断')?(second||summary?['错误']:['正确']):payload.question.includes('填空')?['旧甲','旧乙']:(summary?['B']:second?['D']:['A']);
    }
   }
   if(payload.model_reports)record.textContent+=' · 汇总 '+payload.model_reports.length+' 次回答及思考';
   opts.onload({status:200,responseText:JSON.stringify({usage:{prompt_tokens:128,completion_tokens:32,total_tokens:160},choices:[{finish_reason:'stop',message:{
    ...(!payload.question.includes('无思考字段')?{reasoning_content:new URLSearchParams(location.search).has('layout')
      ?('这是本地长文本布局验证，不代表真实模型输出。'+('long_formula_without_spaces_'.repeat(12))+'\\n').repeat(30)
      :'这是本地模拟的思考内容，用于验证显示效果，不代表真实模型输出。\\n题目为 1 + 1，模拟服务返回答案 2。'}:{}),
    content:JSON.stringify({answers:uncertain?[]:answer,uncertain})}}]})});
  }
 },100);return{abort(){clearTimeout(timer);opts.onabort?.()}};
};
</script><script src="/dist/index.js"></script><script>
document.querySelector('#child-call').onclick=()=>OCS.searchAIAnswer({endpoint:'https://api.deepseek.com',model:'fixture-vision',vision:true,providerName:'子页面模拟'}, {title:'子页面测试题'},1000);
document.querySelector('#auto-results').onclick=async()=>{
 const button=document.querySelector('#auto-results');button.disabled=true;
 const results=OCS.CommonProject.scripts.workResults;await results.methods.clearResults();results.cfg.currentResultIndex=0;
 const pending=[];
 const worker=new OCS.CustomOCSWorker({
  questions:()=>['1 + 1 等于多少？','无思考字段示例：1 + 1 等于多少？','接口失败示例：1 + 1 等于多少？','不确定示例：1 + 1 等于多少？'].map(text=>({text,type:'single'})),
  answerer:title=>OCS.defaultAnswerWrapperHandler(OCS.CommonProject.scripts.settings.methods.getWorkOptions().answererWrappers,{title,type:'single',options:'1\\n2\\n3\\n4'}),
  resolver:infos=>({finish:infos.some(info=>info.results.length>0)}),period:0,
  onResultsUpdate:(result,index)=>pending.push(results.methods.update(index,result))
 });
 try{await worker.doWork();await Promise.all(pending)}finally{button.disabled=false}
};
OCS.start({projects:[{name:'通用',scripts:{settings:OCS.CommonProject.scripts.settings,onlineSearch:OCS.CommonProject.scripts.onlineSearch,workResults:OCS.CommonProject.scripts.workResults,elementRegister:OCS.BackgroundProject.scripts.elementRegister,update:OCS.BackgroundProject.scripts.update,render:OCS.RenderScript}}],renderConfig:{
 renderScript:OCS.RenderScript,styles:[${JSON.stringify(
		fs.readFileSync(path.join(root, 'dist/style.css'), 'utf8')
 )}],defaultPanelName:location.search.includes('updates=')?'background.update':location.search.includes('results=1')?'common.work-results':location.search.includes('search=1')?'common.online-search':'common.settings',title:'OCS Plus · 本地模拟预览'
}});
document.querySelector('#retry-example').onclick=async()=>{
 const button=document.querySelector('#retry-example');button.disabled=true;retryCalls.clear();
 const area=document.querySelector('#retry-questions');area.replaceChildren();
 for(const [index,type] of ['single','multiple','judgement','completion'].entries()){
  const root=document.createElement('section');root.dataset.type=type;root.style='padding:12px;border:1px solid #ccc;margin:8px 0;background:white';
  const title=document.createElement('h3');title.textContent='单题重做模拟'+(index+1)+'：'+({single:'图片单选',multiple:'图片多选',judgement:'判断',completion:'填空'})[type];root.append(title);
  for(let i=0;i<(type==='completion'||type==='judgement'?2:4);i++){
   const wrap=document.createElement('div');wrap.setAttribute('aria-checked','false');
   const option=document.createElement('div');option.className='retry-option';option.style='padding:6px;cursor:pointer';
   if(type==='completion')option.innerHTML='<textarea aria-label="填空'+(i+1)+'"></textarea>';
   else if(type==='judgement')option.textContent=i?'B. 错':'A. 对';
   else option.innerHTML=String.fromCharCode(65+i)+'. <img width="60" height="30" src="/question.svg?option='+i+'">';
   option.onclick=()=>{
    const before=wrap.getAttribute('aria-checked')==='true';
    if(type!=='multiple')for(const other of root.querySelectorAll('[aria-checked]')){other.setAttribute('aria-checked','false');other.style.background=''}
    wrap.setAttribute('aria-checked',String(!before||type!=='multiple'));wrap.style.background=wrap.getAttribute('aria-checked')==='true'?'#d6e4ff':'';
   };
   wrap.append(option);root.append(wrap);
  }
  area.append(root);
 }
 const results=OCS.CommonProject.scripts.workResults;await results.methods.init();results.cfg.currentResultIndex=0;
 const worker=new OCS.OCSWorker({root:[...area.children],elements:{title:'h3',options:'.retry-option'},thread:1,
  answerer:OCS.createCommonAnswerer({period:0,answererWrappers:OCS.CommonProject.scripts.settings.methods.getWorkOptions().answererWrappers,
   titleTransform:elements=>OCS.extractTextWithImages(elements.title[0]),
   optionsTransform:elements=>{const extracted=elements.options.map(el=>OCS.extractTextWithImages(el));return{text:extracted.map(item=>item.text).join('\\n'),images:extracted.flatMap(item=>item.images)}}}),
  work:{type:ctx=>ctx.root.dataset.type,optionText:el=>el.textContent,handler:(type,answer,option)=>{if(type==='completion')option.querySelector('textarea').value=answer;else option.click()}},
  onResultsInit:async(_,__,all)=>results.methods.fillAll(all.map(result=>OCS.simplifyWorkResult(result))),
  onResultsUpdate:async(result,index)=>results.methods.update(index,OCS.simplifyWorkResult(result))
 });
 OCS.enableSingleQuestionRetry(worker,OCS.createCXQuestionRetryAdapter({layout:'exam',type:ctx=>ctx.root.dataset.type,optionText:el=>el.textContent}));
 worker.on('start',()=>OCS.CommonEvents.emitWorkerStateChange('start'));worker.on('done',()=>OCS.CommonEvents.emitWorkerStateChange('done'));worker.on('close',()=>OCS.CommonEvents.emitWorkerStateChange('close'));
 try{await worker.doWork();worker.emit('done')}finally{button.disabled=false}
};
</script><link rel="stylesheet" href="/dist/style.css"></html>`;
module.exports = html;
if (require.main === module)
	http
		.createServer((req, res) => {
			if (new URL(req.url, 'http://127.0.0.1').pathname === '/question.svg') {
				res.setHeader('Content-Type', 'image/svg+xml');
				res.end(
					'<svg xmlns="http://www.w3.org/2000/svg" width="140" height="70"><rect width="140" height="70" fill="white"/><circle cx="40" cy="35" r="20" fill="#4263eb"/><circle cx="100" cy="35" r="20" fill="#14b8a6"/></svg>'
				);
				return;
			}
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
		.listen(Number(process.env.PORT || 4179), '127.0.0.1', () =>
			console.log('AI settings fixture: http://127.0.0.1:' + (process.env.PORT || 4179) + ' (simulated responses only)')
		);
