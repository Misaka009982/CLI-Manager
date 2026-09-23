import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const pages = await (await fetch('http://127.0.0.1:9436/json')).json();
const ws = new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0; const pending=new Map(); const errors=[];
ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);});
function send(method,params={}){return new Promise((resolve,reject)=>{const callId=++id;pending.set(callId,{resolve,reject});ws.send(JSON.stringify({id:callId,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
await send('Runtime.enable');await send('Page.enable');
await send('Page.navigate',{url:'http://127.0.0.1:1426/.trellis/tasks/09-20-external-terminal-program/research/ui-preview.html'});
for(let i=0;i<140;i++){if(await evaluate('Boolean(window.__preview && document.querySelector("input"))'))break;await new Promise(r=>setTimeout(r,400));}
console.log('ERRORS_BEFORE',errors);
console.log('INITIAL',await evaluate('({text:document.body.innerText,state:window.__preview?.state(),metrics:window.__preview?.measure()})'));
let shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(process.env.TEMP,'cli-manager-terminal-zh.png'),Buffer.from(shot.data,'base64'));
await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="English").click()');
await new Promise(r=>setTimeout(r,300));
await evaluate('document.querySelector("input").click()');await new Promise(r=>setTimeout(r,300));
console.log('ENGLISH',await evaluate('document.body.innerText'));
shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(process.env.TEMP,'cli-manager-terminal-en.png'),Buffer.from(shot.data,'base64'));
await evaluate('Array.from(document.querySelectorAll("[role=option]")).find(e=>e.textContent==="CMD").click()');
await new Promise(r=>setTimeout(r,300));
console.log('SELECTED',await evaluate('window.__preview.state()'));
console.log('ERRORS',errors);
ws.close();
