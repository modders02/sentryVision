import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const target = (await (await fetch('http://127.0.0.1:9223/json/list')).json()).find(page => page.type === 'page');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
const errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) { const task = pending.get(message.id); pending.delete(message.id); message.error ? task.reject(message.error) : task.resolve(message.result); }
  else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + message.params.exceptionDetails.exception?.description);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, {resolve,reject}); socket.send(JSON.stringify({id,method,params})); });
const evaluate = async expression => (await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true})).result.value;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = join(tmpdir(), 'msds-transcription-layout-check');
mkdirSync(artifacts, {recursive:true});
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:'http://127.0.0.1:8081/.tmp-transcription-preview.html'});
  for (let attempts=0; attempts<240; attempts++) {
    if (await evaluate('!!document.querySelector("aside[aria-label=\\"Camera activity sidebar\\"]")')) break;
    if (attempts===239) throw new Error('Preview did not render: ' + JSON.stringify({errors,html:await evaluate('document.body.innerHTML')}));
    await pause(500);
  }
  await pause(500);
  const measure = () => evaluate(`(() => {
    const camera=document.querySelector('article'),sidebar=document.querySelector('aside[aria-label="Camera activity sidebar"]'),box=document.querySelector('[aria-label="Transcription for Camera 1"]');
    const cr=camera.getBoundingClientRect(),sr=sidebar.getBoundingClientRect();
    return {camera:{x:cr.x,y:cr.y,width:cr.width,height:cr.height},sidebar:{x:sr.x,y:sr.y,width:sr.width,height:sr.height},box:{height:box.parentElement.getBoundingClientRect().height,client:box.clientHeight,scroll:box.scrollHeight},viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,draftVisible:document.body.textContent.includes('IGNORE THIS DRAFT'),captionOnVideo:!!camera.querySelector('.aspect-video [aria-label^="Transcription"]'),folderWarnings:Array.from(document.querySelectorAll('[role="status"]')).filter(x=>x.textContent==='No folder to save record').length};
  })()`);
  const desktop=await measure();
  if (desktop.sidebar.x < desktop.camera.x+desktop.camera.width || desktop.box.height!==96 || desktop.box.scroll<=desktop.box.client || desktop.draftVisible || desktop.captionOnVideo || desktop.pageWidth>desktop.viewport) throw new Error('Desktop failed: '+JSON.stringify(desktop));
  const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(artifacts,'desktop.png'),Buffer.from(screenshot.data,'base64'));
  await evaluate('window.previewSetTranscript("New original speech.")'); await pause(200);
  const short=await measure();
  if (short.camera.height!==desktop.camera.height || short.box.height!==desktop.box.height) throw new Error('Transcription changed camera height');
  await evaluate('window.previewSetTranscript("")'); await pause(200);
  if (await evaluate('document.body.textContent.includes("New original speech.")')) throw new Error('Cleared words still visible');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true}); await pause(400);
  const mobile=await measure();
  if (mobile.sidebar.y <= mobile.camera.y || mobile.pageWidth>mobile.viewport) throw new Error('Mobile failed: '+JSON.stringify(mobile));
  const mobileScreenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(artifacts,'mobile.png'),Buffer.from(mobileScreenshot.data,'base64'));
  if(errors.length) throw new Error('Browser errors: '+JSON.stringify(errors));
  console.log(JSON.stringify({desktop,short,mobile,artifacts},null,2));
} finally { await send('Browser.close').catch(()=>{}); socket.close(); }
