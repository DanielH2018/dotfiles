const q=document.getElementById('q'),count=document.getElementById('count');
const rows=[...document.querySelectorAll('tr.bind')];
const grps=[...document.querySelectorAll('.grp')];
const cards=[...document.querySelectorAll('.card')];
q&&q.addEventListener('input',()=>{
  const t=q.value.trim().toLowerCase();let n=0;
  for(const r of rows){const hit=!t||r.textContent.toLowerCase().includes(t);r.style.display=hit?'':'none';if(hit)n++;}
  for(const g of grps){g.style.display=[...g.querySelectorAll('tr.bind')].some(r=>r.style.display!=='none')?'':'none';}
  for(const c of cards){const vis=[...c.querySelectorAll('tr.bind')].some(r=>r.style.display!=='none');c.style.display=vis?'':'none';c.open=t?vis:true;}
  count.textContent=t?n+' matches':rows.length+' keybinds';
  relayout(true); // the visible set changed — redeal so filtered-out cards don't leave empty columns
});
// Cards are dealt round-robin into independent .col stacks (same placement the old CSS
// grid gave). A grid row sizes to its tallest card, so expanding one card pushed down the
// cards in every OTHER column too; per-column stacks only reflow their own column.
// Only VISIBLE cards are dealt, and the filter forces a redeal (force=true) — otherwise a
// hidden card keeps its slot and its column just renders blank at 1/n of the width.
const main=document.querySelector('main');let ncols=0;
function relayout(force){
  if(!main)return;
  const vis=cards.filter(c=>c.style.display!=='none');
  const cs=getComputedStyle(main);
  const w=main.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);
  const n=Math.max(1,Math.min(vis.length||1,Math.floor((w+20)/380)));
  if(n===ncols&&!force)return;
  ncols=n;
  main.textContent='';
  const cols=Array.from({length:n},()=>main.appendChild(Object.assign(document.createElement('div'),{className:'col'})));
  vis.forEach((c,i)=>cols[i%n].appendChild(c));
}
relayout(true);
addEventListener('resize',()=>relayout());
