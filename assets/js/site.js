// The roadmap page interactions and the sidebar toggle. Each block checks for its own elements, so this is safe on every page.
(function(){
  // the cloth
  (function(){
    const cloth=document.getElementById('cloth'); if(!cloth) return;
    const grid=document.getElementById('cloth-grid'), areasEl=document.getElementById('cloth-areas'), seam=document.getElementById('seam'), tip=document.getElementById('tip');
    const body=cloth.querySelector('.cloth-body');
    const all=[...grid.querySelectorAll('.sq')];
    const COLS=28, ABOVE=117;
    const stageLabel={done:'Supported',v1:'Before 1.0',after:'After 1.0',never:'Not planned'};
    const NEXT=new Set([57,60,64,117]);
    all.forEach(s=>{ if(NEXT.has(+s.dataset.n)) s.classList.add('next'); });
    function tones(){
      if(!areasEl.hidden){
        areasEl.querySelectorAll('.arow').forEach((row,ri)=>row.querySelectorAll('.sq').forEach((s,ci)=>s.classList.toggle('tb',(ri+ci)%2===1)));
      } else {
        all.forEach((s,i)=>s.classList.toggle('tb',(Math.floor(i/COLS)+i%COLS)%2===1));
      }
    }
    function drawSeam(){
      if(!areasEl.hidden){ seam.innerHTML=''; return; }
      const b=body.getBoundingClientRect();
      const last=all[ABOVE-1].getBoundingClientRect(), nextRow=all[ABOVE].getBoundingClientRect();
      const gap=(nextRow.left-last.right)/2; const x=last.right-b.left+gap; const yLow=last.bottom-b.top+gap; const yHigh=last.top-b.top-gap;
      const w=b.width;
      seam.setAttribute('viewBox',`0 0 ${w} ${b.height}`);
      const gw=grid.getBoundingClientRect().right-b.left; const d2=`M0 ${yLow} H${x} V${yHigh} H${gw+10}`;
      seam.innerHTML=`<path class="under" d="${d2}"/><path class="over" d="${d2}"/><g transform="translate(${gw+12} ${yHigh-11})"><rect class="tag" width="38" height="22" rx="6"/><text class="tagtext" x="19" y="15" text-anchor="middle">1.0</text></g>`;
    }
    function flip(fn){
      const before=new Map(all.map(s=>[s,s.getBoundingClientRect()]));
      fn();
      all.forEach(s=>{ const a=before.get(s), b=s.getBoundingClientRect(); const dx=a.left-b.left, dy=a.top-b.top; const k=a.width/b.width||1;
        s.style.transition='none'; s.style.transform=`translate(${dx}px,${dy}px) scale(${k})`; });
      void body.offsetWidth;
      all.forEach(s=>{ s.style.transition=''; s.classList.add('moving'); s.style.transform=''; });
      setTimeout(()=>{ all.forEach(s=>s.classList.remove('moving')); drawSeam(); }, 600);
    }
    function byRank(){ grid.hidden=false; areasEl.hidden=true; all.forEach(s=>grid.appendChild(s)); areasEl.innerHTML=''; tones(); }
    function byArea(){
      const names=[...new Set(all.map(s=>s.dataset.area))];
      areasEl.innerHTML=''; grid.hidden=true; areasEl.hidden=false;
      names.forEach(n=>{ const sq=all.filter(s=>s.dataset.area===n); const done=sq.filter(s=>s.dataset.stage==='done').length;
        const row=document.createElement('div'); row.className='arow';
        row.innerHTML=`<span class="alabel">${n}</span><span class="acells"></span><span class="acount">${done}/${sq.length}</span>`;
        const cells=row.querySelector('.acells'); sq.forEach(s=>cells.appendChild(s)); areasEl.appendChild(row); });
      tones();
    }
    cloth.querySelectorAll('.seg button').forEach(b=>b.addEventListener('click',()=>{
      cloth.querySelectorAll('.seg button').forEach(x=>x.classList.toggle('on',x===b));
      seam.innerHTML=''; cloth.querySelector('.cloth-title').textContent=b.dataset.mode==='area'?'The cloth, by area':'The cloth, rank 1 to 252'; flip(b.dataset.mode==='area'?byArea:byRank);
    }));
    function showTip(s){ const r=s.getBoundingClientRect(), b=body.getBoundingClientRect();
      tip.innerHTML=`<span class="tn">#${s.dataset.n}</span>${s.dataset.feat}<span class="ts ${s.dataset.stage}">${stageLabel[s.dataset.stage]} · ${s.dataset.area}</span>`;
      tip.hidden=false; let x=r.left-b.left+r.width/2-tip.offsetWidth/2, y=r.top-b.top-tip.offsetHeight-8;
      x=Math.max(0,Math.min(x,b.width-tip.offsetWidth)); if(y<0) y=r.bottom-b.top+8; tip.style.left=x+'px'; tip.style.top=y+'px'; }
    all.forEach(s=>{ s.addEventListener('mouseenter',()=>showTip(s)); s.addEventListener('focus',()=>showTip(s));
      s.addEventListener('mouseleave',()=>tip.hidden=true); s.addEventListener('blur',()=>tip.hidden=true);
      s.addEventListener('click',()=>{ window.parityShow && window.parityShow(+s.dataset.n); }); });
    tones();
    const ro=new ResizeObserver(()=>drawSeam()); ro.observe(body);
    setTimeout(drawSeam, 50);
  })();
  // the list
  (function(){
    let stage='all', area='';
    const list=document.getElementById('plist'); if(!list) return;
    const sel=document.getElementById('area-select');
    function apply(){
      list.querySelectorAll('.prow').forEach(r=>{ const ok=(stage==='all'||r.dataset.stage===stage)&&(!area||r.dataset.area===area); r.classList.toggle('hide',!ok); });
      list.querySelectorAll('.tierhead').forEach(t=>{ let n=t.nextElementSibling, any=false;
        while(n&&!n.classList.contains('tierhead')){ if(n.classList.contains('prow')&&!n.classList.contains('hide')) any=true; n=n.nextElementSibling; }
        t.classList.toggle('hide',!any); });
      document.querySelectorAll('.fbtn').forEach(b=>b.classList.toggle('on',b.dataset.stage===stage));
    }
    function syncDetails(){ document.querySelectorAll('.pdetail').forEach(d=>{ const r=document.getElementById(d.dataset.for); const open=r&&r.classList.contains('open')&&!r.classList.contains('hide'); d.hidden=!open; if(r) r.setAttribute('aria-expanded',String(!!open)); }); }
    document.querySelectorAll('.prow.expandable').forEach(r=>r.addEventListener('click',e=>{ if(e.target.closest('a')) return; r.classList.toggle('open'); syncDetails(); }));
    document.querySelectorAll('.fbtn').forEach(b=>b.addEventListener('click',()=>{ stage=b.dataset.stage; apply(); syncDetails(); }));
    sel.addEventListener('change',()=>{ area=sel.value; apply(); syncDetails(); });
    window.parityShow=function(n){ stage='all'; area=''; sel.value=''; apply(); const row=document.getElementById('prow-'+n); if(!row) return;
      row.scrollIntoView({block:'center',behavior:'smooth'}); row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); };
  })();

  // sidebar collapse
  (function(){ const hide=document.getElementById('navhide'), rail=document.getElementById('navrail'), site=document.querySelector('.site'); if(!hide) return;
    let c=false; try { c=localStorage.getItem('tc-nav')==='collapsed'; } catch(e) {}
    function set(v){ c=v; site.classList.toggle('collapsed',c); rail.hidden=!c; try { localStorage.setItem('tc-nav',c?'collapsed':'open'); } catch(e) {} }
    set(c); hide.addEventListener('click',()=>set(true)); rail.addEventListener('click',()=>set(false)); })();
})();
