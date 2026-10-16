import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { DetectifClient, PipelineError, object, providerMeta, normalizeCombined, failedResult } from './detectif.js';
import { addWindow, applyResult, createSession, decide } from '../shared/decision.js';
import { inspectWav } from '../media/wav.js';
import type { InterviewSession, AudioWindow } from '../shared/contracts.js';

const MAX_BODY=12*1024*1024;
interface RecordEntry { session: InterviewSession; capability: string; enrolling: boolean; deleting: boolean; speakerId: string; operations: Map<string,{hash:string,promise:Promise<unknown>}> }
function fail(code:string,message:string,status=400):never{throw new PipelineError(code,message,status);}
function boundedString(value:unknown,name:string,max=128):string {if(typeof value!=='string'||!value.length||value.length>max)fail('invalid_parameter',`Invalid ${name}`);return value;}
function time(value:unknown,nowMs:number):number {if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>nowMs+2000)fail('invalid_time','Capture time must be finite, nonnegative and not in the future');return value;}
function interval(value:Record<string,any>,nowMs:number){const startMs=time(value.startMs,nowMs),endMs=time(value.endMs,nowMs);if(endMs<=startMs)fail('invalid_interval','Capture interval must have positive duration');return {startMs,endMs};}
async function body(req:IncomingMessage,limit=MAX_BODY){const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)fail('payload_too_large','Request exceeds local upload limit',413);chunks.push(chunk);}return Buffer.concat(chunks);}
function parseJson(bytes:Buffer){try{return object(JSON.parse(bytes.toString('utf8')));}catch{return fail('invalid_json','Invalid JSON body');}}
function metadata(req:IncomingMessage){try{return object(JSON.parse(decodeURIComponent(String(req.headers['x-capture-metadata']??''))));}catch{return fail('invalid_metadata','Missing/invalid X-Capture-Metadata');}}
function send(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
export function createApp(client:DetectifClient, options:{root?:string;now?:()=>number}={}) {
  const records=new Map<string,RecordEntry>();const now=options.now??Date.now;const root=options.root??process.cwd();
  const elapsed=(r:RecordEntry)=>now()-r.session.createdAtEpochMs;
  const snapshot=(r:RecordEntry)=>({session:r.session,decision:decide(r.session,elapsed(r)),nowMs:elapsed(r)});
  function authorize(req:IncomingMessage,id:string){const r=records.get(id);const key=String(req.headers['x-session-key']??'');
    if(!r||key.length!==r.capability.length||!timingSafeEqual(Buffer.from(key),Buffer.from(r.capability)))fail('not_found','Session not found',404);return r;}
  function logical(r:RecordEntry,id:string,payload:Buffer,operation:()=>Promise<unknown>){
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(id))fail('invalid_operation_id','Provide a stable X-Operation-Id for this logical operation');
    const hash=createHash('sha256').update(payload).digest('hex'),existing=r.operations.get(id);
    if(existing){if(existing.hash!==hash)fail('operation_id_reuse','Operation ID was already used for different input',409);return existing.promise;}
    if(r.operations.size>=1200)fail('session_limit','Session operation limit reached; end this session',429);
    const promise=operation();r.operations.set(id,{hash,promise});return promise;
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' blob:; frame-ancestors 'none'");
    try{
      // Local harness: reject non-loopback Host and cross-origin writes (including DNS rebinding).
      const host=String(req.headers.host??'');if(!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host))fail('local_only','This development server accepts only loopback hosts',403);
      const origin=req.headers.origin;if(origin&&origin!==`http://${host}`&&origin!==`https://${host}`)fail('cross_origin','Cross-origin requests are not accepted',403);
      const url=new URL(req.url??'/',`http://${host}`),path=url.pathname,method=req.method;
      if(path==='/api/health'&&method==='GET'){send(res,200,{configured:client.configured,queue:client.queue.stats,storage:'memory_only',mode:'local_development'});return;}
      if(path==='/api/sessions'&&method==='POST'){
        const input=parseJson(await body(req,4096));if(input.consent!==true)fail('consent_required','Explicit consent is required before creating a recording session');
        if(records.size>=50)fail('session_limit','Local session limit reached; restart only after deleting remote speaker profiles',429);
        const id=randomUUID(),session=createSession(id,now(),typeof input.displayName==='string'?input.displayName.slice(0,128):undefined);
        const r:RecordEntry={session,capability:randomBytes(32).toString('hex'),speakerId:`sg-${id}`,enrolling:false,deleting:false,operations:new Map()};records.set(id,r);
        send(res,201,{...snapshot(r),sessionKey:r.capability});return;
      }
      const match=/^\/api\/sessions\/([^/]+)(?:\/(enrollment|windows|interruptions|answers))?$/.exec(path);
      if(match){const r=authorize(req,match[1]!);const action=match[2];
        if(!action&&method==='GET'){send(res,200,snapshot(r));return;}
        if(action==='interruptions'&&method==='POST'){
          const input=parseJson(await body(req,4096));if(input.kind!=='interrupted'&&input.kind!=='resumed')fail('invalid_kind','Invalid capture event');
          if(r.session.interruptions.length>=2000)fail('session_limit','Too many capture events',429);
          r.session={...r.session,interruptions:[...r.session.interruptions,{atMs:time(input.atMs,elapsed(r)),kind:input.kind,reason:boundedString(input.reason,'reason',256)}]};send(res,200,snapshot(r));return;
        }
        if(action==='answers'&&method==='POST'){
          const input=parseJson(await body(req,8192));const times=interval(input,elapsed(r));const id=boundedString(input.id,'answer ID');
          if(r.session.answers.length>=200)fail('session_limit','Too many answers',429);
          if(r.session.answers.some(a=>a.id===id))fail('duplicate_answer','Answer ID already exists',409);
          const questionId=boundedString(input.questionId,'question ID');const text=boundedString(input.questionText,'question text',2000);
          r.session={...r.session,answers:[...r.session.answers,{id,questionId,...times}],questions:r.session.questions.some(q=>q.id===questionId)?r.session.questions:[...r.session.questions,{id:questionId,text}]};
          send(res,200,snapshot(r));return;
        }
        if(action==='enrollment'&&method==='DELETE'){
          if(r.enrolling||r.deleting||r.session.windows.some(w=>w.coverage==='pending'))fail('operation_pending','Wait for outstanding operations before deleting the profile',409);
          // The generated speaker ID also permits cleanup if a timed-out enrollment succeeded remotely.
          r.deleting=true;try{const result=await client.deleteSpeaker(r.speakerId);
            if(result.status<300&&result.body.deleted===true||result.status===404&&result.body.error?.code==='speaker_not_found'){
              if(r.session.enrollment)r.session={...r.session,enrollment:{...r.session.enrollment,deletedAtMs:elapsed(r)}};
              r.session.interruptions.push({atMs:elapsed(r),kind:'interrupted',reason:'Original speaker profile deleted'});
            }send(res,result.status,{provider:result,...snapshot(r)});
          }finally{r.deleting=false;}return;
        }
        if((action==='enrollment'||action==='windows')&&method==='POST'){
          if(req.headers['content-type']!=='audio/wav')fail('unsupported_media','This foundation accepts canonical audio/wav only',415);
          const meta=metadata(req),audio=await body(req),operationId=String(req.headers['x-operation-id']??'');
          const payload=Buffer.concat([Buffer.from(`${action}:${JSON.stringify(meta)}:`),audio]);
          const result=await logical(r,operationId,payload,async()=>{
            const times=interval(meta,elapsed(r));let wav:ReturnType<typeof inspectWav>;
            try{wav=inspectWav(audio);}catch(error){return fail('invalid_audio',(error as Error).message,422);}
            if(Math.abs((times.endMs-times.startMs)-wav.durationMs)>25)fail('duration_mismatch','Capture interval differs from WAV sample duration',422);
            if(r.deleting)fail('profile_deleting','Speaker profile is being deleted',409);
            if(action==='enrollment'){
              if(r.enrolling||r.session.enrollment)fail('original_reference_locked','A session has one original reference; it cannot be replaced',409);
              if(wav.durationMs<15000||wav.durationMs>60000)fail('enrollment_duration','Enrollment must be 15–60 seconds, including at least 10 seconds of clear speech',422);
              r.enrolling=true;try{
                const response=await client.enroll(r.speakerId,audio,operationId),b=response.body;
                if(response.status<300&&b.speaker?.speaker_id===r.speakerId&&b.operation_id&&b.quality?.speech_seconds>=10){
                  r.session={...r.session,enrollment:{id:randomUUID(),speakerId:r.speakerId,participantId:r.session.candidate.id,enrolledAtMs:elapsed(r),provider:providerMeta(b,response.requestId),authenticity:'not_checked'}};
                }
                return {provider:response,accepted:Boolean(r.session.enrollment),warning:'Development enrollment has not passed an authenticity precheck. Job 3 must add it.'};
              }finally{r.enrolling=false;}
            }
            const reference=r.session.enrollment;if(!reference||reference.deletedAtMs!==undefined)fail('enrollment_required','Enroll a reference before checking audio',409);
            if(r.session.windows.length>=1000)fail('session_limit','Window limit reached',429);
            const id=boundedString(meta.id,'window ID'),sequence=meta.sequence;
            if(!Number.isInteger(sequence)||sequence<0)fail('invalid_sequence','Sequence must be a nonnegative integer');
            if(meta.purpose!=='monitor'&&meta.purpose!=='reverify')fail('invalid_purpose','Use monitor or reverify');
            if(meta.source!=='candidate_microphone'&&meta.source!=='labelled_upload')fail('invalid_source','Provide candidate-only audio or an explicitly labelled upload');
            if(wav.durationMs>60000)fail('audio_too_long','Verification audio must be <=60 seconds',422);
            const window:AudioWindow={id,sessionId:r.session.id,sequence,...times,answerIds:r.session.answers.filter(a=>a.startMs<times.endMs&&a.endMs>times.startMs).map(a=>a.id),source:meta.source,purpose:meta.purpose,referenceId:reference.id,mimeType:'audio/wav',sampleRate:wav.sampleRate,sampleCount:wav.sampleCount,mediaOffsetMs:0,coverage:wav.durationMs<=4000?'skipped':'pending',reason:wav.durationMs<=4000?'Short final fragment: combined checking requires >4 seconds':undefined,submittedAtMs:elapsed(r)};
            try{r.session=addWindow(r.session,window);}catch(error){fail('invalid_window',(error as Error).message,409);}
            if(window.coverage==='skipped')return {windowId:id,skipped:true};
            try{const response=await client.verify(reference.speakerId,audio,operationId);r.session=applyResult(r.session,normalizeCombined(response,window,elapsed(r)));}
            catch(error){r.session=applyResult(r.session,failedResult(window,elapsed(r),error));}
            return {windowId:id};
          });send(res,200,{operation:result,...snapshot(r)});return;
        }
        fail('method_not_allowed','Unsupported session route or method',405);
      }
      if(method==='GET'){
        const files:Record<string,string>={'/':'public/index.html','/style.css':'public/style.css','/pcm-worklet.js':'public/pcm-worklet.js'};
        const relative=files[path]??(/^\/modules\/(browser|media|shared)\/[a-z-]+\.js$/.test(path)?`dist/src/${path.slice('/modules/'.length)}`:undefined);
        if(relative){try{const bytes=await readFile(resolve(root,relative));res.writeHead(200,{'content-type':extname(relative)==='.html'?'text/html; charset=utf-8':extname(relative)==='.css'?'text/css':'text/javascript','cache-control':'no-store'});res.end(bytes);return;}catch{fail('not_found','Build the app before opening the harness',404);}}
      }
      fail('not_found','Route not found',404);
    }catch(error){const e=error instanceof PipelineError?error:new PipelineError('internal_error','Unexpected local server error',500);if(!res.headersSent)send(res,e.status,{error:{code:e.code,message:e.message}});else res.end();}
  });
  server.requestTimeout=150_000;server.headersTimeout=15_000;
  return {server,records};
}
