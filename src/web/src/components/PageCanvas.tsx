import { useEffect, useRef, useState } from 'react';
import type { EditorModel } from '../editor/EditorModel';
import type { Guide } from '../contracts/generated';
import type { GestureToken } from '../canvas/GestureController';
import { ContextMenu } from './ContextMenu';
import { ObjectList } from './ObjectList';
import { SegmentHandles } from './SegmentHandles';
import { RouteDiagnostics } from './RouteDiagnostics';
import { Ruler, RULER_SIZE } from './Ruler';
import { useModel } from './useModel';

export function PageCanvas({ model }: { model: EditorModel }) {
  useModel(model);
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = host.current!;
    model.attachCanvas(el);
    const ro = new ResizeObserver(() => { const r = frame.current!.getBoundingClientRect(); setSize({ w: r.width - RULER_SIZE, h: r.height - RULER_SIZE }); });
    ro.observe(frame.current!);
    return () => { ro.disconnect(); model.detachCanvas(); };
  }, [model]);

  const drag = useRef<{ token: GestureToken; guide: Guide; pageId: string; offset: number } | null>(null);
  const [preview, setPreview] = useState<Guide | null>(null);
  const cancelGuide = () => { if(drag.current) model.controller.cancel(drag.current.token); drag.current=null;setPreview(null); };
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => { if(e.key === 'Escape') cancelGuide(); };
    window.addEventListener('keydown',cancel); return () => window.removeEventListener('keydown',cancel);
  },[model]);
  useEffect(() => { const d=drag.current;if(d && (model.currentPage.id!==d.pageId || model.snapshot.revision!==d.token.startRevision || model.snapshot.sessionId!==d.token.startSnapshot.sessionId)) cancelGuide(); });
  useEffect(() => () => { if(drag.current) model.controller.cancel(drag.current.token); },[model]);
  const point = (e: React.PointerEvent) => {
    const vp=model.viewport;const r=host.current?.getBoundingClientRect();
    return vp&&r?{x:(e.clientX-r.left+vp.scrollLeft)/vp.scale-vp.marginPt,y:(e.clientY-r.top+vp.scrollTop)/vp.scale-vp.marginPt}:null;
  };
  const startGuide = (e: React.PointerEvent<HTMLDivElement>) => {
    if(e.button!==0 || model.controller.isActive()) return;
    const target=e.target as HTMLElement;const testid=target.dataset.testid ?? '';
    const existing=testid.startsWith('guide-')?model.currentPage.guides.find(g=>'guide-'+g.id===testid):undefined;
    if(!existing && testid!=='ruler-h' && testid!=='ruler-v') return;
    const guide=existing??{id:crypto.randomUUID(),orientation:testid==='ruler-h'?'horizontal':'vertical',positionPt:0} as Guide;
    const token=model.controller.begin('guide',model.engine.scope(),[]);
    const at=point(e);
    const offset=existing&&at?(guide.orientation==='horizontal'?at.y:at.x)-guide.positionPt:0;
    drag.current={token,guide,pageId:model.currentPage.id,offset};setPreview(guide);
    e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveGuide = (e: React.PointerEvent) => {
    const d=drag.current;const at=point(e);if(!d||!at)return;
    e.preventDefault();setPreview({...d.guide,positionPt:(d.guide.orientation==='horizontal'?at.y:at.x)-d.offset});
  };
  const endGuide = async (e: React.PointerEvent<HTMLDivElement>) => {
    const d=drag.current;if(!d)return;const at=point(e);const r=frame.current!.getBoundingClientRect();
    const onRuler=d.guide.orientation==='horizontal'?e.clientY>=r.top&&e.clientY<r.top+RULER_SIZE&&e.clientX>=r.left+RULER_SIZE&&e.clientX<=r.right:e.clientX>=r.left&&e.clientX<r.left+RULER_SIZE&&e.clientY>=r.top+RULER_SIZE&&e.clientY<=r.bottom;
    const page=model.currentPage;
    const hostRect=host.current!.getBoundingClientRect();
    const insideCanvas=e.clientX>=hostRect.left&&e.clientX<=hostRect.right&&e.clientY>=hostRect.top&&e.clientY<=hostRect.bottom;
    if(!onRuler&&!insideCanvas){cancelGuide();return;}
    if(!at || page.id!==d.pageId || (!onRuler && (at.x<0||at.y<0||at.x>page.widthPt||at.y>page.heightPt))) {cancelGuide();return;}
    const original=d.token.startSnapshot.document.pages.find(p=>p.id===d.pageId)!;
    const existing=original.guides.some(g=>g.id===d.guide.id);
    const next=original.guides.filter(g=>g.id!==d.guide.id);
    if(!onRuler)next.push({...d.guide,positionPt:(d.guide.orientation==='horizontal'?at.y:at.x)-d.offset});
    // Retain array order for an unchanged release and preserve every unrelated identity.
    const guides=existing&&!onRuler?original.guides.map(g=>g.id===d.guide.id?next.at(-1)!:g):next;
    const ops=JSON.stringify(guides)===JSON.stringify(original.guides)?[]:[{op:'setPage' as const,pageId:d.pageId,patch:{guides}}];
    const planned=model.controller.preview(d.token,ops);drag.current=null;setPreview(null);
    if(!planned.ok){model.controller.cancel(d.token);model.say(planned.error.message,'warning');return;}
    const result=await model.controller.commit(d.token);if(!result.ok)model.say(result.error.message,'warning');
  };

  const onDrop = (e: React.DragEvent) => {
    const what = e.dataTransfer.getData('application/x-diagram-shape');
    const picture = e.dataTransfer.getData('application/x-diagram-asset');
    if (!what && !picture) return;
    e.preventDefault();
    const vp = model.canvas!.getViewport();
    const rect = host.current!.getBoundingClientRect();
    const at = { x: (e.clientX - rect.left + vp.scrollLeft) / vp.scale - vp.marginPt, y: (e.clientY - rect.top + vp.scrollTop) / vp.scale - vp.marginPt };
    if (picture) { try { void model.placeAsset(JSON.parse(picture) as { scope: 'library' | 'document'; id: string }, at); } catch { /* not ours */ } return; }
    void model.place(what, at);
  };

  return (
    <div className="canvas-frame" ref={frame} onPointerDownCapture={startGuide} onPointerMove={moveGuide} onPointerUp={e=>void endGuide(e)} onPointerCancel={cancelGuide} onLostPointerCapture={cancelGuide}>
      <div className="ruler-corner" />
      <Ruler horizontal viewport={model.viewport} unit={model.unit} length={size.w} />
      <Ruler horizontal={false} viewport={model.viewport} unit={model.unit} length={size.h} />
      <div
        className="canvas-host" data-testid="canvas" ref={host}
        onDragOver={e => { if (e.dataTransfer.types.includes('application/x-diagram-shape') || e.dataTransfer.types.includes('application/x-diagram-asset')) e.preventDefault(); }}
        onDrop={onDrop}
        onMouseDown={() => setTimeout(() => frame.current?.querySelector<HTMLElement>('[data-testid=object-list]')?.focus({ preventScroll: true }), 0)} // keys go to the object list after a click, so the keyboard carries on from the clicked object
        onContextMenu={e => { e.preventDefault(); setMenuAt({ x: e.clientX + 1, y: e.clientY + 1 }); }} // one pixel off the pointer, as maxGraph's own popup does, so the button's release reaches the shape under it rather than the menu; a release on the menu reads as a background click and clears the selection
      />
      {model.showGuides && model.viewport && <div style={{position:'absolute',left:RULER_SIZE,top:RULER_SIZE,right:0,bottom:0,pointerEvents:'none',overflow:'hidden',zIndex:4}} data-testid="guides-overlay">
        {[...model.currentPage.guides.filter(g=>g.id!==preview?.id),...(preview?[preview]:[])].map(g=>{
          const vp=model.viewport!;const horizontal=g.orientation==='horizontal';
          const pos=(g.positionPt+vp.marginPt)*vp.scale-(horizontal?vp.scrollTop:vp.scrollLeft);
          return <div key={g.id} data-testid={'guide-'+g.id} role="separator" aria-label={g.orientation+' guide'} aria-orientation={g.orientation} style={{position:'absolute',pointerEvents:'auto',cursor:horizontal?'ns-resize':'ew-resize',...(horizontal?{left:0,right:0,top:pos-3,height:7,borderTop:'1px dashed #0284c7',transform:'translateY(3px)'}:{top:0,bottom:0,left:pos-3,width:7,borderLeft:'1px dashed #0284c7',transform:'translateX(3px)'})}} />;
        })}
      </div>}
      {model.beautifyPrompt?.preview && model.viewport && <div style={{position:'absolute',left:RULER_SIZE,top:RULER_SIZE,right:0,bottom:0,pointerEvents:'none',overflow:'hidden',zIndex:5}} data-testid="beautify-overlay">
        <svg width="100%" height="100%" viewBox={`0 0 ${size.w} ${size.h}`} aria-label="Proposed connector routes">
          {model.beautifyPrompt.preview.proposedRoutes.map(route => {
            const points = route.points.map(p => `${(p.x + model.viewport!.marginPt) * model.viewport!.scale - model.viewport!.scrollLeft},${(p.y + model.viewport!.marginPt) * model.viewport!.scale - model.viewport!.scrollTop}`).join(' ');
            return <polyline key={route.id} data-route-id={route.id} points={points} fill="none" stroke="#16a34a" strokeWidth={Math.max(2, 2 / model.viewport!.scale)} strokeDasharray={`${6 / model.viewport!.scale} ${4 / model.viewport!.scale}`} />;
          })}
        </svg>
      </div>}
      <RouteDiagnostics model={model} />
      <SegmentHandles model={model} />
      <ObjectList model={model} />
      {menuAt && <ContextMenu model={model} at={menuAt} onClose={() => setMenuAt(null)} />}
    </div>
  );
}
