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
const contentLeft=309, contentScale=(width-contentLeft)/width;
const localX=x=>(x-contentLeft)/contentScale;
function rectInContent(r){return Object.assign({},r,{x:contentLeft+r.x*contentScale,w:r.w*contentScale});}
function targets(page,view) {
    if(page==='trip')return home.menuTargets();
    const local=(view.buttons||[]).map(button=>{
        const target=rectInContent(button);
        if(button.track)target.track=rectInContent(button.track);
        return target;
    });
    return local.concat(home.railTargets(page));
}
function actionTarget(page,view,command){
    const all=targets(page,view);
    const exact=all.find(b=>b.command===command&&b.enabled!==false);
    if(exact)return exact;
    const value=/^atlasValue:([a-zA-Z0-9_]+):(0|[1-9][0-9]*)$/.exec(command);
    if(!value)return null;
    return all.find(b=>b.enabled!==false && b.kind==='slider' && b.source===value[1] &&
        Number.isInteger(b.step) && Number(value[2])<=b.max)||null;
}
// Layout coordinates stretch to the viewport. Glyphs, circular signs and QR
// modules keep square pixels, including inside the narrower detail pane.
function paneCanvas(canvas,left,sx,sy) {
    const x=value=>left+value*sx;
    const unit=Math.min(sx,sy);
    return {
        scaleX:sx/sy,
        square:(a,b,size)=>({canvas,x:Math.round(x(a)),y:Math.round(b*sy),size:Math.floor(size*unit)}),
        fillRect:(a,b,w,h,color)=>{
            const leftEdge=Math.round(x(a)),topEdge=Math.round(b*sy);
            canvas.fillRect(leftEdge,topEdge,Math.round(x(a+w))-leftEdge,Math.round((b+h)*sy)-topEdge,color);
        },
        roundRect:(a,b,w,h,r,color)=>canvas.roundRect(x(a),b*sy,w*sx,h*sy,r*unit,color),
        strokeRoundRect:(a,b,w,h,r,n,color)=>canvas.strokeRoundRect(x(a),b*sy,w*sx,h*sy,r*unit,n*unit,color),
        circle:(a,b,r,color)=>canvas.circle(x(a),b*sy,r*unit,color),
        arc:(a,b,r,R,start,end,color)=>canvas.arc(x(a),b*sy,r*unit,R*unit,start,end,color),
        line:(a,b,c,d,n,color)=>canvas.line(x(a),b*sy,x(c),d*sy,n*unit,color),
        polyline:(points,n,color)=>canvas.polyline(points.map(v=>[x(v[0]),v[1]*sy]),n*unit,color),
        text:(str,a,b,size,color,opts)=>canvas.text(str,x(a),b*sy,size*unit,color,opts),
        textWidth:(str,size,opts)=>canvas.textWidth(str,size*unit,opts)/sx
    };
}
function sceneAtSize(canvas,page,view,focus,screenWidth,screenHeight) {
    const sx=screenWidth/width, sy=screenHeight/height;
    const surface=paneCanvas(canvas,0,sx,sy);
    if(page==='trip'){home.drawHome(surface,view,focus);return;}
    detail.drawDetail(paneCanvas(canvas,contentLeft*sx,contentScale*sx,sy),page,view,focus);
    home.drawRail(surface,page,focus);
    const target=targets(page,view).find(item=>item.kind!=='section' && item.enabled!==false&&(item.focusKey||item.command)===focus);
    if(target)surface.strokeRoundRect(target.x+2,target.y+2,target.w-4,target.h-4,8,3,'#b6f3bf');
}
function scene(canvas,page,view,focus,interactive) {
    if(interactive)sceneAtSize(canvas,page,view,focus,width,height);
    else if(page==='trip')home.drawSummary(canvas,view);
    else detail.drawSummary(canvas,page,view);
}
function sameSize(placement,screen) {
    return !!(placement && screen && placement.w===screen.w && placement.h===screen.h);
}
// The SDK reports a short and a held deflection for each direction.
function tiltAxis(value,positive,negative){
    if(value===positive||value===positive+1)return 1;
    if(value===negative||value===negative+1)return -1;
    return 0;
}
class Stage {
    constructor(log,invoke,invalidate,driver,onFocus) {
        this.log=log;this.invoke=invoke;this.invalidate=invalidate;this.driver=driver||RenderClient;
        this.onFocus=onFocus||(()=>{});
        this.gpu=null;this.page=null;this.view=null;this.focus={};this.contentFocus={};this.key=null;this.pressed=null;
        this.hold=null;
        this.sliderPreview=null;this.drag=null;this.nudge=null;this.nudgeTimer=null;this.lastCcu=null;this.placement=null;this.blocked=false;this.dirty=false;this.front=false;this.confirmedFront=false;
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
        if(this.gpu && (changed||signature!==this.key||!sameSize(this.placement,this.gpu.screen)))this.present();
        this.key=signature;
    }
    connect() {
        const gpu=new this.driver('marku_kaluga_cameras',this.log,{native:true});
        this.gpu=gpu;
        gpu.on('ready',()=>{
            this.lastCcu=null;
            this.present();
            if(this.page)this.invalidate();
        });
        gpu.on('tick',()=>{
            if(this.dirty || (this.page && !sameSize(this.placement,gpu.screen)))this.present();
        });
        gpu.on('state',s=>{
            const previous=this.front;
            this.confirmedFront=!!(s.front&&s.onScreen);
            this.front=!!(this.page&&this.confirmedFront);
            if(!this.front){this.finishNudge(false);this.cancelTouch(false);this.lastCcu=null;gpu.grab(false);if(previous)this.onFocus(null);}
            else if(this.owns()){
                gpu.grab(true);
                const selected=this.selected(targets(this.page,this.view));
                this.onFocus(selected&&selected.command);
            }
            if(previous!==this.front)this.invalidate();
        });
        gpu.on('touch',(phase,x,y)=>{
            const area=this.placement;
            if(sameSize(area,gpu.screen))this.touch(phase,x*width/area.w,y*height/area.h);
        });
        gpu.on('ccu',v=>this.controller(v));
        gpu.on('closed',()=>{this.forgetForeground();this.release();this.blocked=true;this.invalidate();});
        gpu.on('close',()=>{this.forgetForeground();this.release();this.invalidate();});
        gpu.connect();
    }
    owns() {
        const g=this.gpu;
        return !!(this.page && !this.blocked && g && g.ready && g.native &&
            g.touch && g.info && g.info.touch && g.info.controller && g.info.frontGate && g.screen &&
            Number.isInteger(g.screen.w) && g.screen.w>0 && g.screen.w<=0x7fffffff &&
            Number.isInteger(g.screen.h) && g.screen.h>0 && g.screen.h<=0x7fffffff);
    }
    selected(items) {
        return items.find(t=>(t.focusKey||t.command)===this.focus[this.page]&&t.enabled!==false)||items.find(t=>t.enabled!==false);
    }
    present() {
        const gpu=this.gpu;
        if(!this.owns()){
            if(this.placement){this.release();this.invalidate();}
            return;
        }
        const screen=gpu.screen;
        if(!sameSize(this.placement,screen)){
            this.finishNudge(false);
            this.cancelTouch(false);
            this.placement={x:0,y:0,w:screen.w,h:screen.h,scale:1,ox:0,oy:0};
            gpu.place(this.placement);
            this.front=this.confirmedFront;
        }
        if(gpu.waiting){this.dirty=true;return;}
        this.dirty=false;
        const items=targets(this.page,this.view), selected=this.selected(items);
        const frame=new Recorder(screen.w,screen.h);
        const shown=this.sliderPreview || this.hold ? Object.assign({},this.view,{
            sliderPreview:this.sliderPreview, holding:this.hold && this.hold.command
        }) : this.view;
        sceneAtSize(frame,this.page,shown,selected&&(selected.focusKey||selected.command),screen.w,screen.h);
        gpu.show(true);gpu.frame(frame);
        gpu.claim([{x:0,y:0,w:screen.w,h:screen.h}]);
        if(this.front){
            gpu.grab(true);
            if(selected&&selected.kind!=='section')this.contentFocus[this.page]=selected.focusKey||selected.command;
            this.onFocus(selected&&selected.command);
        }
    }
    touch(phase,x,y) {
        if(!this.owns()||!this.gpu.visible||!this.front)return;
        const all=targets(this.page,this.view);
        const target=all.find(t=>t.enabled!==false && x>=t.x && x<t.x+t.w && y>=t.y && y<t.y+t.h);
        if(phase===1){
            this.finishNudge(true);
            this.cancelTouch(false);
            if(target&&target.kind==='slider'&&target.track){
                const t=target.track;
                // Wide rows place the label beside the track. On compact
                // cards the label above the track remains a separate OK target.
                const top=t.wide?target.y:Math.max(target.y+target.h/2,t.y-18);
                const withinTrack=x>=t.x-8 && x<=t.x+t.w+8 && y>=top;
                if(withinTrack) this.drag={page:this.page,source:target.source};
            }
            this.pressed=target&&target.command;
            if(target&&target.holdMs)this.startHold(target,'touch');
        }
        if(this.drag){
            const origin=this.drag, local=(this.view.buttons||[]).find(b=>b.kind==='slider'&&b.source===origin.source&&b.enabled!==false);
            if(!local||origin.page!==this.page){this.cancelTouch();return;}
            if(phase!==1&&phase!==2&&phase!==3)return;
            const command=detail.sliderCommand(local,localX(x));
            if(!command){this.cancelTouch();return;}
            const step=Number(command.split(':')[2]);
            this.focus[this.page]=local.focusKey||local.command;
            this.sliderPreview={source:local.source,step};
            if(phase===3){
                this.cancelTouch(false);
                if(step!==local.step)this.invoke(command);
            }
            this.present();
            return;
        }
        if(phase===2 && (!target||this.pressed!==target.command)){
            this.pressed=null;
            this.cancelHold();
        }
        if(phase===3 || (phase!==1 && phase!==2))this.cancelHold();
        if(phase!==3)return;
        const same=target&&target.command===this.pressed;this.pressed=null;
        if(same && !target.holdMs)this.activate(target);
    }
    startHold(target,source){
        this.cancelHold(false);
        this.focus[this.page]=target.focusKey||target.command;
        const hold={command:target.command,source,page:this.page};
        this.hold=hold;
        hold.timer=setTimeout(()=>{
            if(this.hold!==hold)return;
            this.hold=null;
            const current=this.page===hold.page && this.view && actionTarget(this.page,this.view,hold.command);
            if(current && this.owns() && this.front && this.gpu.visible &&
                this.focus[this.page]===(current.focusKey||current.command))this.activate(current);
            this.present();
        },target.holdMs);
        this.present();
    }
    cancelHold(redraw){
        if(!this.hold)return;
        clearTimeout(this.hold.timer);
        this.hold=null;
        if(redraw!==false)this.present();
    }
    cancelTouch(redraw){
        this.cancelHold(false);
        const previous=this.sliderPreview;
        this.drag=null;this.pressed=null;this.sliderPreview=null;
        if(previous&&redraw!==false)this.present();
    }
    nudgeSlider(item,delta){
        const last=this.nudge;
        const step=last&&last.page===this.page&&last.source===item.source?last.step:item.step;
        const command=detail.sliderNudge(Object.assign({},item,{step}),delta);
        if(!command)return;
        const proposed=Number(command.split(':')[2]);
        this.nudge={page:this.page,source:item.source,step:proposed,command};
        this.sliderPreview={source:item.source,step:proposed};
        clearTimeout(this.nudgeTimer);
        this.nudgeTimer=setTimeout(()=>this.finishNudge(true),90);
        this.present();
    }
    finishNudge(commit){
        const pending=this.nudge;
        if(!pending)return;
        clearTimeout(this.nudgeTimer);
        this.nudge=null;this.nudgeTimer=null;this.sliderPreview=null;
        if(!commit)return;
        const item=this.page===pending.page && this.view && (this.view.buttons||[])
            .find(t=>t.kind==='slider'&&t.source===pending.source&&t.enabled!==false);
        if(item&&item.step!==pending.step)this.invoke(pending.command);
        this.present();
    }
    activate(target) {
        this.finishNudge(true);
        this.focus[this.page]=target.focusKey||target.command;
        this.onFocus(target.command);
        this.invoke(target.command);
    }
    controller(v) {
        if(!this.owns()||!this.front||!this.gpu.grabbing)return;
        const k=Number(v.frontRotaryEncoderOperation), b=Number(v.frontRotaryEncoderPushButton), d=Number(v.frontRotaryEncoderDeflection);
        if(!Number.isInteger(k)||k<0||k>65535||b===15&&d===15){this.cancelHold();this.lastCcu=null;return;}
        const last=this.lastCcu;this.lastCcu={k,b,d};if(!last)return;
        const items=targets(this.page,this.view).filter(t=>t.enabled!==false);if(!items.length)return;
        const cur=this.selected(items),i=items.indexOf(cur);
        let delta=((k-last.k+32768)&65535)-32768;
        if(Math.abs(delta)>64)delta=0;
        const horizontal=tiltAxis(d,4,10), vertical=tiltAxis(d,7,1);
        const pressedHorizontal=horizontal&&horizontal!==tiltAxis(last.d,4,10);
        if(this.hold && this.hold.source==='controller' &&
            ((b!==1&&b!==2)||delta||d!==last.d||this.hold.command!==cur.command)) this.cancelHold();
        if(cur.kind==='slider' && ((pressedHorizontal&&!this.view.edit)||(delta&&this.view.edit))){
            this.nudgeSlider(cur,delta||horizontal);
            if((b===1||b===2)&&last.b!==1&&last.b!==2)this.activate(cur);
            return;
        }
        if(pressedHorizontal && this.page!=='trip'){
            this.finishNudge(true);
            const content=items.filter(t=>t.kind!=='section');
            const dest=horizontal<0?items.find(t=>t.kind==='section'&&t.selected):
                content.find(t=>(t.focusKey||t.command)===this.contentFocus[this.page])||content[0];
            if(dest){this.focus[this.page]=dest.focusKey||dest.command;this.present();}
            return;
        }
        if(!delta && vertical!==tiltAxis(last.d,7,1))delta=vertical;
        if(delta){this.finishNudge(true);const item=items[Math.max(0,Math.min(items.length-1,i+delta))];this.focus[this.page]=item.focusKey||item.command;this.present();}
        if((b===1||b===2)&&last.b!==1&&last.b!==2){
            const target=this.selected(items);
            if(target.holdMs)this.startHold(target,'controller');
            else this.activate(target);
        }
    }
    nativeFocus(command) {
        if(!this.page)return;
        this.focus[this.page]=command;
        if(command.indexOf('atlasNav:')!==0)this.contentFocus[this.page]=command;
        if(this.owns())this.present();
    }
    forgetForeground() { this.cancelHold(false);this.confirmedFront=false;this.front=false; }
    release() {
        const gpu=this.gpu;if(gpu){if(gpu.ready)gpu.claim([]);gpu.grab(false);gpu.show(false);}
        this.lastCcu=null;this.finishNudge(false);this.cancelTouch(false);this.placement=null;this.dirty=false;this.front=false;
    }
    close() {
        this.release();this.page=null;if(this.gpu)this.gpu.close();this.gpu=null;
    }
}
module.exports={Stage,drawPng,scene,sceneAtSize,targets,actionTarget,width,height,summaryHeight};
