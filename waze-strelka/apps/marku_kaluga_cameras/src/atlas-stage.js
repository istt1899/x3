// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const fs=require('fs');
const path=require('path');
const home=require('./atlas-home.js');
const detail=require('./atlas-detail.js');

// The unit linker places the application bundle beside the original MIT kit.
// Source tests load the same files from the selected package tree.
let kit=path.join(__dirname,'atlas-kit');
if(!fs.existsSync(kit)) {
    const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'..','mgu-app.json'),'utf8'));
    kit=path.join(__dirname,'..',manifest.tree,'javascript','atlas-kit');
}
const {Canvas}=require(path.join(kit,'canvas.js'));
const {Recorder}=require(path.join(kit,'record.js'));
const {RenderClient}=require(path.join(kit,'renderd.js'));
const width=1600,height=520;
const nativeControl={command:'atlasNative',label:'Все действия',x:1337,y:7,w:248,h:58,enabled:true};
function drawPng(draw) {
    const c=new Canvas(width,height);
    draw(c);return c.png(1);
}
function targets(page,view) {
    return page==='trip'?home.menuTargets():(view.buttons||[]).concat([nativeControl]);
}
function scene(c,page,view,focus,interactive) {
    if(page==='trip'){home.drawHome(c,view,focus);return;}
    detail.drawDetail(c,page,interactive?view:Object.assign({},view,{buttons:[]}));
    if(!interactive)return;
    c.roundRect(nativeControl.x,nativeControl.y,nativeControl.w,nativeControl.h,8,'#294636');
    c.text(nativeControl.label,1461,46,24,'#d6efd7',{align:'center',literal:true});
    const selected=targets(page,view).find(t=>t.command===focus);
    if(selected)c.strokeRoundRect(selected.x+2,selected.y+2,selected.w-4,selected.h-4,8,3,'#b6f3bf');
}
class Stage {
    constructor(log,invoke,invalidate,driver) {
        this.log=log;this.invoke=invoke;this.invalidate=invalidate;this.driver=driver||RenderClient;
        this.gpu=null;this.page=null;this.view=null;this.focus={};this.key=null;this.pressed=null;
        this.lastCcu=null;this.nativePage=null;this.placement=null;this.blocked=false;this.dirty=false;this.front=false;
    }
    set(page,view,signature) {
        const changed=this.page!==page;
        if(changed){this.release();this.nativePage=null;this.page=page;this.blocked=false;}
        this.view=view;
        if(!page)return;
        if(!this.gpu && this.driver.available())this.connect();
        if(this.gpu && (changed||signature!==this.key))this.present();
        this.key=signature;
    }
    connect() {
        const gpu=new this.driver('marku_kaluga_cameras',this.log,{native:true});
        this.gpu=gpu;
        gpu.on('ready',()=>{this.lastCcu=null;this.present();});
        gpu.on('tick',()=>{if(this.dirty)this.present();});
        gpu.on('state',s=>{
            this.front=s.front&&s.onScreen;
            if(!this.front){this.pressed=null;this.lastCcu=null;gpu.grab(false);}
            else if(this.owns())gpu.grab(true);
        });
        gpu.on('touch',(phase,x,y)=>this.touch(phase,x,y));
        gpu.on('ccu',v=>this.controller(v));
        gpu.on('closed',()=>{this.release();this.blocked=true;this.invalidate();});
        gpu.on('close',()=>{this.release();this.invalidate();});
        gpu.connect();
    }
    owns() {
        const g=this.gpu;
        return !!(this.page && this.nativePage!==this.page && !this.blocked && g && g.ready && g.native &&
            g.touch && g.info && g.info.touch && g.info.controller && g.info.frontGate && g.screen.w===1920 && g.screen.h===720);
    }
    selected(items) {
        return items.find(t=>t.command===this.focus[this.page]&&t.enabled!==false)||items.find(t=>t.enabled!==false);
    }
    present() {
        const gpu=this.gpu;if(!this.owns())return;
        if(gpu.waiting){this.dirty=true;return;}
        this.dirty=false;
        // Measured RHMI Laptimer content area. BMW's own Back, title and native
        // bar remain outside this surface, including on the detailed pages.
        if(!this.placement){this.placement={x:124,y:82,w:width,h:height,scale:1,ox:0,oy:0};gpu.place(this.placement);}
        const items=targets(this.page,this.view), selected=this.selected(items);
        const frame=new Recorder(width,height);
        scene(frame,this.page,this.view,selected&&selected.command,true);
        gpu.show(true);gpu.frame(frame);
        gpu.claim(items.filter(t=>t.enabled!==false).map(t=>({x:t.x,y:t.y,w:t.w,h:t.h})));
        if(this.front)gpu.grab(true);
    }
    touch(phase,x,y) {
        if(!this.owns()||!this.gpu.visible||!this.front)return;
        const target=targets(this.page,this.view).find(t=>t.enabled!==false && x>=t.x && x<t.x+t.w && y>=t.y && y<t.y+t.h);
        if(phase===1){this.pressed=target&&target.command;return;}
        if(phase===2 && (!target||this.pressed!==target.command))this.pressed=null;
        if(phase!==3)return;
        const same=target&&target.command===this.pressed;this.pressed=null;
        if(same)this.activate(target);
    }
    activate(target) {
        this.focus[this.page]=target.command;
        if(target.command==='atlasNative'){this.nativePage=this.page;this.release();this.invalidate();return;}
        this.invoke(target.command);
    }
    controller(v) {
        if(!this.owns()||!this.front||!this.gpu.grabbing)return;
        const k=Number(v.frontRotaryEncoderOperation), b=Number(v.frontRotaryEncoderPushButton), d=Number(v.frontRotaryEncoderDeflection);
        if(!Number.isInteger(k)||k<0||k>65535||b===15&&d===15){this.lastCcu=null;return;}
        const last=this.lastCcu;this.lastCcu={k,b,d};if(!last)return;
        const items=targets(this.page,this.view).filter(t=>t.enabled!==false);if(!items.length)return;
        const cur=this.selected(items),i=items.indexOf(cur);
        let delta=((k-last.k+32768)&65535)-32768;
        if(Math.abs(delta)>64)delta=0;
        if(!delta && last.d!==d){if([1,2,10,11].includes(d))delta=-1;else if([4,5,7,8].includes(d))delta=1;}
        if(delta){this.focus[this.page]=items[Math.max(0,Math.min(items.length-1,i+delta))].command;this.present();}
        if((b===1||b===2)&&last.b!==1&&last.b!==2)this.activate(this.selected(items));
    }
    nativeFocus(command) {
        if(!this.page)return;
        this.focus[this.page]=command;
        if(this.owns())this.present();
    }
    release() {
        const gpu=this.gpu;if(gpu){if(gpu.ready)gpu.claim([]);gpu.grab(false);gpu.show(false);}
        this.lastCcu=null;this.pressed=null;this.placement=null;this.dirty=false;this.front=false;
    }
    close() {
        this.release();this.page=null;if(this.gpu)this.gpu.close();this.gpu=null;
    }
}
module.exports={Stage,drawPng,scene,targets,width,height};
