// Build a schedule exactly the way app.js keys it (weekKey = toISOString of local Monday)
function getMonday(d){const date=new Date(d);const day=date.getDay();const diff=date.getDate()-day+(day===0?-6:1);date.setDate(diff);date.setHours(0,0,0,0);return date;}
function dk(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
const s={};
for(let d=new Date(2026,8,20);d<=new Date(2026,11,10);d.setDate(d.getDate()+1)){
  const wk=getMonday(d).toISOString().slice(0,10); s[wk]=s[wk]||{};
  for(const sh of ['day','night']) if(!(d.getMonth()===10 && d.getDate()%3===0)) s[wk][`${dk(d)}_${sh}`]=['d1','d2'];
}
console.log(JSON.stringify(s));
