// Adds a batch of expressions to phrases.json after checking format and duplicates.
// Usage: node tools/add_phrases.mjs batch.json
// batch.json: {"t":"Theme name","items":[["fr","en","familier|argot|courant|soutenu","example sentence","usage note in English"], ...]}
import fs from "node:fs";
const root=new URL("..",import.meta.url).pathname, REG=new Set(["familier","argot","courant","soutenu"]);
const key=s=>String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[’']/g,"'").replace(/[^a-z0-9' ]/g," ").replace(/\s+/g," ").trim();
const batch=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(!batch.t||!Array.isArray(batch.items)) throw new Error("batch needs t and items");
const packPath=root+"phrases.json", pack=fs.existsSync(packPath)?JSON.parse(fs.readFileSync(packPath,"utf8")):{batches:[]};
const html=fs.readFileSync(root+"index.html","utf8"), have=new Set();
for(const m of html.matchAll(/\["((?:[^"\\]|\\.)+)","/g)) have.add(key(m[1]));
pack.batches.forEach(b=>b.items.forEach(x=>have.add(key(x[0]))));
const ok=[], skipped=[];
for(const x of batch.items){
  const why=!Array.isArray(x)||x.length<4?"needs [fr,en,reg,ex,note]":!REG.has(x[2])?"bad register "+x[2]:x.slice(0,4).some(v=>typeof v!=="string"||!v.trim())?"empty field":have.has(key(x[0]))?"duplicate":null;
  if(why){ skipped.push(`${x&&x[0]} (${why})`); continue; }
  have.add(key(x[0])); ok.push([x[0].trim(),x[1].trim(),x[2],x[3].trim(),String(x[4]||"").trim()]);
}
if(ok.length) pack.batches.push({d:new Date().toISOString().slice(0,10),t:batch.t,items:ok});
pack.total=pack.batches.reduce((n,b)=>n+b.items.length,0);
fs.writeFileSync(packPath,"{\n\"total\":"+pack.total+",\n\"batches\":[\n"+pack.batches.map(b=>' {"d":'+JSON.stringify(b.d)+',"t":'+JSON.stringify(b.t)+',"items":[\n'+b.items.map(i=>"  "+JSON.stringify(i)).join(",\n")+"\n ]}").join(",\n")+"\n]}\n");
console.log(`added ${ok.length}, skipped ${skipped.length}, pack total ${pack.total}`); if(skipped.length) console.log("skipped:\n  "+skipped.join("\n  "));
