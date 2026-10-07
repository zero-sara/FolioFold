/* One review dialog, captured record identity, explicit apply, local LLM only. */
/* 2026-10-03：direction（整理方向）以前根本没传给后端 —— 下拉框是装饰品，选什么都一样。
   现在对话框里自带方向选择（项目页的外部「AI 整理控制」会把当前方向带进来），
   整理时随素材一起发到 /api/ai/parse，由 ai_organizer.py 拼进 system prompt。 */
const AI_DIRECTIONS=['作品集导向','专业简洁','技术导向'];
function openOrganizer(kind, record, direction) {
  document.querySelector('#organizer-dialog')?.remove();
  const dialog=document.createElement('dialog');
  dialog.id='organizer-dialog';
  dialog.style.cssText='width:min(900px,90vw);max-height:90vh;overflow:auto;padding:24px;background:#f3f0e9;color:#161616';
  const dirOptions=AI_DIRECTIONS.map(d=>'<option value="'+d+'"'+(d===direction?' selected':'')+'>'+d+'</option>').join('');
  dialog.innerHTML='<h2>AI 文本整理</h2><label>整理方向 <select id="organizer-dir">'+dirOptions+'</select></label><p class="hint" id="organizer-dir-hint"></p><label>原始素材<textarea id="organizer-raw" style="min-height:180px;white-space:pre-wrap"></textarea></label><p id="organizer-status" role="status" aria-live="polite"></p><button class="button" id="organizer-run">开始 AI 整理</button><section id="organizer-result" hidden><h3>AI 整理结果（可手动修改）</h3><div id="organizer-fields" class="fields"></div><button class="button primary" id="organizer-apply">应用结果</button></section><button class="button" id="organizer-cancel">取消</button>';
  document.body.append(dialog);
  const q=s=>dialog.querySelector(s), raw=q('#organizer-raw'), status=q('#organizer-status'), run=q('#organizer-run'), dir=q('#organizer-dir');
  const DIR_HINT={ '作品集导向':'讲清作品是什么、创作意图与最终效果 —— 适合放在作品集里给访客看。',
                   '专业简洁':'只留事实与职责，短句直给、去形容词 —— 适合被快速扫读。',
                   '技术导向':'突出工作流、工具规格、技术难点与解法 —— 适合同行 / 技术面试。'};
  const syncDirHint=()=>{const h=q('#organizer-dir-hint');if(h)h.textContent=DIR_HINT[dir.value]||'';};
  dir.onchange=syncDirHint; syncDirHint();
  raw.value=record.rawMaterial||'';
  let result=null,controller=null;
  const labels={projectName:'项目名称',date:'日期',company:'公司',role:kind==='experience'?'职位':'角色',projectSummary:kind==='experience'?'经历介绍':'项目介绍',keyWork:kind==='experience'?'具体职责':'核心工作',highlights:'核心亮点'};
  const close=()=>{controller?.abort();dialog.close();dialog.remove();};
  dialog.addEventListener('cancel',e=>{e.preventDefault();close()});
  q('#organizer-cancel').onclick=close;
  run.onclick=async()=>{
    if(!raw.value.trim()){status.textContent='请先粘贴原始素材。';return}
    controller=new AbortController();run.disabled=true;raw.disabled=true;dir.disabled=true;result=null;q('#organizer-result').hidden=true;
    status.textContent='AI 正在理解并整理（'+dir.value+'）……首次加载模型可能较慢，请稍候。';
    try{
      const response=await fetch('/api/ai/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,direction:dir.value,rawMaterial:raw.value}),signal:controller.signal});
      const body=await response.json();
      if(!response.ok)throw Error(body.error||'AI 请求失败');
      result=body.result;
      q('#organizer-fields').innerHTML=Object.entries(labels).map(([key,label])=>'<label class="field">'+label+'<textarea data-ai-field="'+key+'">'+esc(Array.isArray(result[key])?result[key].join('\n'):result[key]||'')+'</textarea></label>').join('');
      q('#organizer-result').hidden=false;status.textContent='请审核结果。应用前，当前项目和原始素材保持原样。';run.textContent='重新整理';
    }catch(error){if(error.name!=='AbortError')status.textContent=error.message}
    finally{run.disabled=false;raw.disabled=false;dir.disabled=false}
  };
  q('#organizer-apply').onclick=()=>{
    if(!result)return;
    const collection=kind==='experience'?data.experience:data.projects;
    if(!collection.includes(record)){status.textContent='原记录已移除，无法应用。';return}
    const values={};
    dialog.querySelectorAll('[data-ai-field]').forEach(el=>values[el.dataset.aiField]=['keyWork','highlights'].includes(el.dataset.aiField)?el.value.split('\n').map(x=>x.trim()).filter(Boolean):el.value.trim());
    const previous=clone(record);
    push();
    record.rawMaterial=raw.value;
    if(values.date)record.date=values.date;
    if(values.company)record.company=values.company;
    if(kind==='project'){
      if(values.projectName)record.name=values.projectName;
      if(values.role)record.role=values.role;
      record.structuredContent={...record.structuredContent,summary:values.projectSummary,keyWork:values.keyWork,highlights:values.highlights};
      Object.assign(record,{summary:values.projectSummary,keyWork:values.keyWork,highlights:values.highlights});
    }else{
      if(values.role)record.position=values.role;
      record.structuredContent={...record.structuredContent,summary:values.projectSummary,responsibilities:values.keyWork,highlights:values.highlights};
      Object.assign(record,{summary:values.projectSummary,responsibilities:values.keyWork,highlights:values.highlights});
    }
    delete record.aiDraft;
    close();render();toast('已填入当前记录，请保存草稿');
    const undoButton=document.createElement('button');undoButton.className='button';undoButton.textContent='撤销 AI 整理';
    undoButton.onclick=()=>{Object.keys(record).forEach(k=>delete record[k]);Object.assign(record,previous);render();toast('已恢复应用前内容')};
    document.querySelector('.actions').append(undoButton);
  };
  dialog.showModal();
}
