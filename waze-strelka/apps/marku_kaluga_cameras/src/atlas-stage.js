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
const summaryHeight=240;
function drawPng(draw,frameHeight) {
    const canvas=new Canvas(width,frameHeight||height);
    draw(canvas);
    return canvas.png(1);
}
function targets(page,view) {
    return page==='trip'?home.menuTargets():view.buttons||[];
}
function scene(canvas,page,view,focus,interactive) {
    if(!interactive){
        if(page==='trip')home.drawSummary(canvas,view);
        else detail.drawSummary(canvas,page,view);
        return;
    }
    if(page==='trip')home.drawHome(canvas,view,focus);
    else detail.drawDetail(canvas,page,view,focus);
    const target=targets(page,view).find(item=>item.enabled!==false&&(item.focusKey||item.command)===focus);
    if(target && page!=='trip')canvas.strokeRoundRect(target.x+2,target.y+2,target.w-4,target.h-4,8,3,'#b6f3bf');
}
class Stage {
    constructor(log,invoke,invalidate,driver,onFocus) {
        this.log=log;this.invoke=invoke;this.invalidate=invalidate;this.driver=driver||RenderClient;
        this.onFocus=onFocus||(()=>{});
        this.gpu=null;this.page=null;this.view=null;this.focus={};this.key=null;this.pressed=null;
        this.lastCcu=null;this.placement=null;this.blocked=false;this.dirty=false;this.front=false;this.confirmedFront=false;
    }
    set(page,view,signature) {
        const changed=this.page!==page;
        if(changed){
            this.release();
            this.page=page;this.blocked=false;
            // A transition between two Atlas screens may use one compositor
            // transaction and generate no second foreground notification.
            this.front=!!(page&&this.confirmedFront);
        }
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
            const previous=this.front;
            this.confirmedFront=!!(s.front&&s.onScreen);
            this.front=!!(this.page&&this.confirmedFront);
            if(!this.front){this.pressed=null;this.lastCcu=null;gpu.grab(false);if(previous)this.onFocus(null);}
            else if(this.owns()){
                gpu.grab(true);
                const selected=this.selected(targets(this.page,this.view));
                this.onFocus(selected&&selected.command);
            }
            if(previous!==this.front)this.invalidate();
        });
        gpu.on('touch',(phase,x,y)=>this.touch(phase,x,y));
        gpu.on('ccu',v=>this.controller(v));
        gpu.on('closed',()=>{this.forgetForeground();this.release();this.blocked=true;this.invalidate();});
        gpu.on('close',()=>{this.forgetForeground();this.release();this.invalidate();});
        gpu.connect();
    }
    owns() {
        const g=this.gpu;
        return !!(this.page && !this.blocked && g && g.ready && g.native &&
            g.touch && g.info && g.info.touch && g.info.controller && g.info.frontGate && g.screen.w===1920 && g.screen.h===720);
    }
    selected(items) {
        return items.find(t=>(t.focusKey||t.command)===this.focus[this.page]&&t.enabled!==false)||items.find(t=>t.enabled!==false);
    }
    present() {
        const gpu=this.gpu;if(!this.owns())return;
        if(gpu.waiting){this.dirty=true;return;}
        this.dirty=false;
        // Measured RHMI Laptimer content area. BMW's own Back, title and native
        // chrome remain outside this surface, including on the detailed pages.
        if(!this.placement){this.placement={x:124,y:82,w:width,h:height,scale:1,ox:0,oy:0};gpu.place(this.placement);}
        const items=targets(this.page,this.view), selected=this.selected(items);
        const frame=new Recorder(width,height);
        scene(frame,this.page,this.view,selected&&(selected.focusKey||selected.command),true);
        gpu.show(true);gpu.frame(frame);
        // All pixels on our surface belong to this frame, including its empty
        // space. A tap between cards must not reach an HMI widget underneath.
        gpu.claim([{x:0,y:0,w:width,h:height}]);
        if(this.front){gpu.grab(true);this.onFocus(selected&&selected.command);}
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
        this.focus[this.page]=target.focusKey||target.command;
        this.onFocus(target.command);
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
        if(delta){const item=items[Math.max(0,Math.min(items.length-1,i+delta))];this.focus[this.page]=item.focusKey||item.command;this.present();}
        if((b===1||b===2)&&last.b!==1&&last.b!==2)this.activate(this.selected(items));
    }
    nativeFocus(command) {
        if(!this.page)return;
        this.focus[this.page]=command;
        if(this.owns())this.present();
    }
    forgetForeground() { this.confirmedFront=false;this.front=false; }
    release() {
        const gpu=this.gpu;if(gpu){if(gpu.ready)gpu.claim([]);gpu.grab(false);gpu.show(false);}
        this.lastCcu=null;this.pressed=null;this.placement=null;this.dirty=false;this.front=false;
    }
    close() {
        this.release();this.page=null;if(this.gpu)this.gpu.close();this.gpu=null;
    }
}
module.exports={Stage,drawPng,scene,targets,width,height,summaryHeight};
