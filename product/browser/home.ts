/** Reviewer overview. Counts and status always come from the real session API. */
import { api, el, JOIN_LABEL, requireReviewer } from './api.js';
import type { OpsView, SessionSummary } from './api.js';
import { $, badge, clear, copyButton, errorText, findKey, fmtEpoch, notice, stateBadge, table } from './render.js';
import { icon } from './shell.js';
import { mountSignal } from './signal.js';
const auth = await requireReviewer();
const app = $('app'); clear(app);
let sessions: SessionSummary[] = [], filter = 'all';
const heading = el('div', {class:'page-heading'}, el('div',{},el('span',{class:'eyebrow'},'SWITCHGUARD / REVIEW DESK'),el('h1',{},'The interview desk.'),el('p',{class:'lead'},'Your conversations, evidence and open questions.')));
const createButton=el('button',{class:'primary',type:'button'},icon('plus'),'New interview');heading.append(createButton);
const hero=el('section',{class:'overview-hero'},el('div',{class:'hero-copy'},el('span',{class:'eyebrow'},'01 / VOICE CONTINUITY'),el('h2',{},'One conversation.',el('br'),'A continuous thread.'),el('p',{},'Compare each answer with the original voice reference. Open a flagged moment to hear it in context.'),el('a',{class:'hero-link',href:'/sandbox.html'},'Try a controlled recording',icon('arrow'))));
const art=el('div',{class:'signal-art','aria-hidden':'true'});hero.append(art,el('span',{class:'hero-caption'},'FIG. 01 — CONTINUITY STUDY · INTERACTIVE'));
const metrics=el('section',{class:'metric-grid','aria-label':'Workspace statistics'});
const listPanel=el('section',{class:'panel sessions-panel',id:'sessions'});
const opsPanel=el('section',{class:'panel ops-panel',id:'operations'});
const search=el('input',{type:'search',placeholder:'Search candidates…','aria-label':'Search sessions by candidate name'});
const listBody=el('div',{class:'session-list'});
const tabs=el('div',{class:'filter-tabs',role:'group','aria-label':'Filter sessions'});
for(const [value,label] of [['all','All sessions'],['live','In progress'],['flagged','With flags'],['sandbox','Sandbox']]) {
  const b=el('button',{type:'button',class:value==='all'?'filter-tab active':'filter-tab','aria-pressed':String(value==='all')},label);
  b.addEventListener('click',()=>{filter=value!;for(const item of tabs.querySelectorAll('button')){item.classList.toggle('active',item===b);item.setAttribute('aria-pressed',String(item===b));}renderList();});tabs.append(b);
}
search.addEventListener('input',renderList);
const refresh=el('button',{type:'button',class:'quiet-button'},'Refresh');refresh.addEventListener('click',()=>void loadSessions());
listPanel.append(el('div',{class:'panel-heading'},el('div',{},el('h2',{},'Interview sessions'),el('p',{class:'muted'},'Open a session to review its timeline and recordings.')),refresh),el('div',{class:'list-toolbar'},tabs,el('div',{class:'search-field'},icon('search'),search)),listBody);
app.append(heading,hero,metrics,listPanel,el('div',{class:'home-bottom'},opsPanel));
void mountSignal(art);

const dialog=el('dialog',{class:'create-dialog','aria-labelledby':'create-title'});
const close=el('button',{type:'button',class:'dialog-close','aria-label':'Close new interview'},icon('close'));close.addEventListener('click',()=>dialog.close());
const name=el('input',{id:'candidate-name',type:'text',required:'',placeholder:'e.g. Alex Morgan',maxlength:'80',autocomplete:'off'});
const submit=el('button',{type:'submit',class:'primary'},'Create interview',icon('arrow'));
const form=el('form',{},el('label',{for:'candidate-name'},'Candidate name'),name,submit);
const result=el('div',{class:'created-result','aria-live':'polite'});
dialog.append(close,el('span',{class:'eyebrow'},'START A CONVERSATION'),el('h2',{id:'create-title'},'A new interview.'),el('p',{class:'lead'},'Create a private space for your next conversation.'),form,result);
document.body.append(dialog);
function openCreate(){if(!dialog.open)dialog.showModal();name.focus();}
createButton.addEventListener('click',openCreate);document.addEventListener('sg:new-interview',openCreate);
dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
form.addEventListener('submit',async event=>{event.preventDefault();if(!name.value.trim())return;submit.disabled=true;clear(result);
  try {const created=await api.createSession(auth,{displayName:name.value.trim(),kind:'interview'});const link=location.origin+created.candidateUrl;
    result.append(badge('Interview created','ok'),el('h3',{},'Your candidate’s private link'),el('div',{class:'copy-link'},el('input',{type:'text',readonly:'',value:link,'aria-label':'Private candidate link'}),copyButton(()=>link)),el('p',{class:'muted'},'Share this link privately. Anyone with it can join as this candidate.'),el('a',{class:'button-link primary',href:`/reviewer.html?s=${encodeURIComponent(created.sessionId)}`},'Open review workspace',icon('arrow')));
    name.value='';void loadSessions();
  }catch(e){result.append(notice(errorText(e),'bad'));}finally{submit.disabled=false;}
});
function renderMetrics(){clear(metrics);const live=sessions.filter(s=>s.status==='live').length;const flags=sessions.reduce((n,s)=>n+s.evidenceCount,0);
  for(const [title,value,caption,symbol,tone] of [['Total sessions',sessions.length,'Across your workspace','grid',''],['In progress',live,'Interviews currently running','wave','green'],['Evidence flags',flags,'Signals saved for human review','flag','amber'],['Completed',sessions.filter(s=>s.status==='ended').length,'Conversations concluded','check','']]) {
    metrics.append(el('article',{class:`metric ${tone}`},el('div',{class:'metric-title'},el('span',{},String(title)),icon(String(symbol))),el('strong',{class:'metric-value'},String(value)),el('span',{class:'metric-caption'},String(caption))));
  }
}
function renderList(){clear(listBody);const query=search.value.trim().toLowerCase();const filtered=sessions.filter(s=>(!query||s.displayName.toLowerCase().includes(query))&&(filter==='all'||filter==='live'&&s.status==='live'||filter==='flagged'&&s.evidenceCount>0||filter==='sandbox'&&s.kind==='sandbox'));
  if(!filtered.length){const button=el('button',{type:'button',class:'primary'},sessions.length?'Clear filters':'Create your first interview');button.addEventListener('click',()=>{if(!sessions.length){openCreate();return;}search.value='';(tabs.querySelector('button') as HTMLButtonElement).click();});
    listBody.append(el('div',{class:'empty-state'},icon('wave'),el('h3',{},sessions.length?'No matching sessions.':'Your next conversation starts here.'),el('p',{class:'muted'},sessions.length?'Try another name or choose a different filter.':'Invite a candidate, establish a voice reference and review each answer with context.'),button));return;}
  const rows=filtered.map(s=>{const id=encodeURIComponent(s.sessionId);const initials=s.displayName.split(/\s+/).filter(Boolean).slice(0,2).map(n=>n[0]).join('').toUpperCase();
    const candidate=el('div',{class:'candidate-cell'},el('span',{class:`candidate-avatar ${s.kind==='sandbox'?'sage':''}`},initials||'S'),el('div',{},el('a',{class:'candidate-name',href:`/reviewer.html?s=${id}`},s.displayName),el('span',{class:'candidate-subtitle'},s.kind==='sandbox'?'Controlled test session':'Interview session')));
    const joinable=s.kind==='interview'&&s.joinStatus!=='completed';
    const actions=el('div',{class:'session-actions'},
      joinable&&!s.interviewerJoined?el('a',{href:`/reviewer.html?s=${id}&join=1`,class:'button-link primary','aria-label':`Join the interview with ${s.displayName}`},'Join interview'):'',
      el('a',{href:`/reviewer.html?s=${id}`,class:'review-link'},joinable&&s.interviewerJoined?'Open interview':'Review',icon('arrow')));
    const more=el('details',{class:'row-menu'});const summary=el('summary',{'aria-label':`More actions for ${s.displayName}`},'···');
    const del=el('button',{type:'button',class:'danger'},'Delete session');del.addEventListener('click',async()=>{if(!confirm(`Delete “${s.displayName}”, its media and remote speaker profile? This cannot be undone.`))return;del.disabled=true;try{await api.deleteSession(auth,s.sessionId);void loadSessions();void loadOps();}catch(e){alert(errorText(e));del.disabled=false;}});
    more.append(summary,el('div',{class:'row-menu-content'},el('a',{href:`/report.html?s=${id}`},'Evidence report'),del));actions.append(more);
    const statusLabel=s.kind==='interview'?JOIN_LABEL[s.joinStatus]+(s.status==='paused'?' · paused':''):s.status==='ended'?'Completed':'Sandbox run';
    const statusTone=s.joinStatus==='ready_to_join'?'ok':s.joinStatus==='in_progress'?'info':'gap';
    const sessionCell=el('div',{class:'session-status'},badge(statusLabel,statusTone),
      s.kind==='interview'&&s.joinStatus!=='completed'?el('span',{class:'candidate-subtitle'},s.candidateConnected?'Candidate connected':'Candidate not connected'):'');
    const evidenceCell=el('div',{},s.evidenceCount?badge(`${s.evidenceCount} flag${s.evidenceCount===1?'':'s'}`,'warn'):el('span',{class:'muted'},'No flags'),
      s.reviewRequestsToReview?badge(`${s.reviewRequestsToReview} re-evaluation${s.reviewRequestsToReview===1?'':'s'} to review`,'warn'):'',
      s.openReviewRequests?badge('Re-evaluation in progress','info'):'',
      s.escalated?badge(`Escalated${s.escalated>1?` ×${s.escalated}`:''}`,'bad'):'',
      s.suspiciousGestures?badge(`${s.suspiciousGestures} suspicious gesture check${s.suspiciousGestures===1?'':'s'}`,'bad'):'',
      s.splitAnswers?badge(`${s.splitAnswers} answer${s.splitAnswers===1?'':'s'} with another voice`,'bad'):'',
      s.peopleHeard>1?badge(`${s.peopleHeard} voices heard`,'warn'):'',
      s.localSignals?badge(`${s.localSignals} voice-consistency note${s.localSignals===1?'':'s'}`,'gap'):'');
    return [candidate,sessionCell,stateBadge(s.state),evidenceCell,el('time',{class:'session-date',datetime:new Date(s.createdAtEpochMs).toISOString(),title:fmtEpoch(s.createdAtEpochMs)},new Date(s.createdAtEpochMs).toLocaleDateString(undefined,{month:'short',day:'numeric'})),actions];
  });listBody.append(table(['Candidate','Session','Latest signal','Evidence','Created',''],rows),el('div',{class:'table-footer'},`${filtered.length} of ${sessions.length} sessions`,el('span',{},'Signals inform. You decide.')));
}
/** Keeps the desk current (new responses, joins, status changes) without disturbing an open menu or dialog. */
setInterval(()=>{if(document.hidden||dialog.open||listBody.querySelector('details[open]'))return;void loadSessions(true);},5000);
async function loadSessions(quiet=false){if(!quiet)refresh.disabled=true;try{sessions=(await api.sessions(auth)).sessions.sort((a,b)=>b.createdAtEpochMs-a.createdAtEpochMs);renderMetrics();renderList();}catch(e){if(quiet&&sessions.length)return;clear(listBody);listBody.append(notice(`Could not load sessions: ${errorText(e)}. Retrying automatically.`,'bad'));}finally{refresh.disabled=false;}}
function renderOps(ops:OpsView){clear(opsPanel);const d=ops.detectif;const status=findKey(d.health,'status');const available=findKey(d.credits,'available')??findKey(d.credits,'balance');const creditError=findKey(d.credits,'error');const fixture=findKey(d.health,'note')==='fixture'||findKey(d.credits,'plan')==='fixture';const okay=d.configured&&(status==='ok'||status==='healthy')&&!d.error;
  opsPanel.append(el('div',{class:'panel-heading'},el('h2',{},'Connection & capacity'),badge(fixture?'Fixture preview':okay?'Connected':!d.configured?'Not configured':'Check connection',fixture?'warn':okay?'ok':'warn')),
    el('div',{class:'ops-provider'},el('span',{class:'provider-symbol'},icon('wave')),el('div',{},el('strong',{},'DetectifAI'),el('span',{class:'muted'},'Voice analysis provider'))),
    el('div',{class:'ops-facts'},el('div',{},el('span',{},'Available credits'),el('strong',{},available===undefined?(creditError?'Unavailable':'Not reported'):String(available))),el('div',{},el('span',{},'Processing queue'),el('strong',{},`${ops.queue.active} active · ${ops.queue.waiting} waiting`)),el('div',{},el('span',{},'Media retention'),el('strong',{},`${ops.mediaRetentionHours} hours`))));
  if(fixture&&!document.getElementById('fixture-banner')){const banner=notice('Preview environment · Scripted test data. No live voice analysis.','warn');banner.id='fixture-banner';app.prepend(banner);}
  if(d.error)opsPanel.append(notice(d.error,'warn'));const refreshOps=el('button',{class:'quiet-button',type:'button'},'Refresh status ↻');refreshOps.addEventListener('click',()=>void loadOps());opsPanel.append(refreshOps);
}
async function loadOps(){try{renderOps(await api.ops(auth));}catch(e){clear(opsPanel);opsPanel.append(el('h2',{},'Connection & capacity'),notice(errorText(e),'bad'));}}
void loadSessions();void loadOps();if(location.hash==='#new'){openCreate();history.replaceState(null,'',location.pathname);}
