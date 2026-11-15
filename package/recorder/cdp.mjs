import fs from 'node:fs';
import { EventEmitter } from 'node:events';
export class CDP extends EventEmitter {
  constructor(url) {super();const u=new URL(url);if(u.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Debugger must be loopback');this.ws=new WebSocket(url);this.seq=0;this.pending=new Map();this.scripts=[];this.breakpoints=[];
    this.ws.addEventListener('message',event=>{try{const m=JSON.parse(event.data);if(m.id){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}else{if(m.method==='Debugger.scriptParsed')this.scripts.push(m.params);this.emit(m.method,m.params);}}catch(e){this.emit('fault',e);}});
    this.ws.addEventListener('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Debugger disconnected'));}this.pending.clear();this.emit('disconnected');});
    this.ws.addEventListener('error',()=>this.emit('fault',Error('Debugger socket error')));
  }
  async open(){if(this.ws.readyState===WebSocket.OPEN)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Debugger connect timeout')),5000);this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});this.ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Debugger connect failed'));},{once:true});});}
  call(method,params={}){return new Promise((resolve,reject)=>{if(this.ws.readyState!==WebSocket.OPEN)return reject(Error('Debugger not connected'));const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Debugger timeout: '+method));},7000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
  async detach(){const cleanup=[];for(const id of this.breakpoints){try{await this.call('Debugger.removeBreakpoint',{breakpointId:id});cleanup.push({id,removed:true});}catch(e){cleanup.push({id,removed:false,error:e.message});}}this.breakpoints=[];
    if(this.ws.readyState===WebSocket.OPEN)try{await this.call('Debugger.disable');}catch(e){cleanup.push({debuggerDisabled:false,error:e.message});}
    if(this.ws.readyState!==WebSocket.CLOSED){await new Promise(resolve=>{const t=setTimeout(resolve,2000);this.ws.addEventListener('close',()=>{clearTimeout(t);resolve();},{once:true});this.ws.close();});}return {cleanup,disconnected:this.ws.readyState===WebSocket.CLOSED};}
}
