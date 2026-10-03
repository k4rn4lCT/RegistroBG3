(function(){
 'use strict';
 const R=K4Rules;let api,room=null,state=null,privateState=null,off=[],processing=new Set(),selected=null,notice='',online=true,pendingSubmit=null;
 let roomSheets=new Map();let eventQueue=[],seen=new Set(),baseline=false,showing=null,monitorTimer=null,monitorPaused=false;
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const id=()=>crypto.randomUUID();
 const btn=(action,label,extra='',disabled=false)=>`<button type="button" class="btn tiny" data-k4="${action}" ${extra} ${disabled?'disabled':''}>${label}</button>`;
 const val=(name,fallback='')=>document.getElementById('k4-'+name)?.value??fallback;
 const options=(actors,current)=>actors.map(a=>`<option value="${escape(a.id)}" ${a.id===current?'selected':''}>${escape(a.name)} · ${a.hp}/${a.max}</option>`).join('');
 const attrNames={fue:'Fuerza',des:'Destreza',con:'Constitución',int:'Inteligencia',sab:'Sabiduría',car:'Carisma'};
 const longAttrs={fue:'fuerza',des:'destreza',con:'constitucion',int:'inteligencia',sab:'sabiduria',car:'carisma'};
 const savingBonus=(a,k)=>R.n(a.dnd?.atributos?.[longAttrs[k]]?.salvacion,R.n(a.saves?.[k],R.mod(a.stats?.[k])));
 function buildActor(character,owner){const a=R.actor(character,owner);a.resources=api.resources(character).map(r=>({...r,maximo:r.maximo===Infinity?1000000:r.maximo}));a.xp=R.n(character.dnd?.px);return a;}
 function roomPlayers(){return api.players().map(j=>({...j,fichaMesa:roomSheets.get(j.id)?.character||j.fichaMesa}));}
 function rootRef(){return api.db().collection('campanias').doc(room.gmUid).collection('lista').doc(room.campId);}
 function isGM(){return room&&api.uid()===room.gmUid&&!api.monitor();}
 function mine(){return (privateState||state)?.actors.filter(a=>a.ownerUid===api.uid()&&a.type==='pj'&&state?.actors.some(x=>x.id===a.id))||[];}
 function ensureRoom(){
   const s=api.getState();const v=s?.campaign?.salaVinculada;
   const target=s?.campaign?.esSala?{gmUid:api.uid(),campId:api.campaignId()}:v?{gmUid:v.gmUid,campId:v.campId}:null;
   if(!target||!target.gmUid||!target.campId){detach();return;}
   if(room?.gmUid===target.gmUid&&room.campId===target.campId)return;
   attach(target);
 }
 function detach(){off.forEach(f=>f());off=[];room=null;state=null;privateState=null;roomSheets.clear();pendingSubmit=null;selected=null;baseline=false;seen.clear();eventQueue=[];showing=null;clearTimeout(monitorTimer);}
 function attach(target){
   detach();room=target;const ref=rootRef();
   const watch=isGM()?'private':'public';
   off.push(ref.collection('mesaV2').doc(watch).onSnapshot({includeMetadataChanges:true},d=>{
     if(!d.exists)return;
     if(d.metadata.hasPendingWrites&&!isGM())return;
     if(isGM()&&api.getState()?.campaign.mesaImportPending)return;
     const data=d.data();if(data.schema!==2||!Array.isArray(data.actors)||!Array.isArray(data.order)||!Array.isArray(data.pending)){notice='Estado incompleto rechazado; se conserva el último estado confirmado.';return;}
     state=data;if(isGM())privateState=state;
     online=!d.metadata.fromCache;
     projectOwnCharacter();paint();
   },e=>{notice='No se pudo sincronizar: '+e.message;online=false;paint();}));
   if(!isGM()&&!api.monitor()){
     off.push(ref.collection('actoresV2').where('ownerUid','==',api.uid()).onSnapshot(snap=>{
       const actors=snap.docs.map(d=>d.data());privateState={actors};projectOwnCharacter();paint();
     }));
     off.push(ref.collection('comandosV2').where('ownerUid','==',api.uid()).onSnapshot(snap=>{
       for(const d of snap.docs){const c=d.data();if(d.id===pendingSubmit&&c.status!=='pending'){pendingSubmit=null;notice=c.status==='rejected'?c.error:'Acción confirmada y guardada';}}paint();
     }));
   }
   if(isGM())off.push(ref.collection('fichasV2').onSnapshot(snap=>{roomSheets=new Map(snap.docs.map(d=>[d.id,d.data()]));paint();}));
   if(isGM())off.push(ref.collection('comandosV2').where('status','==','pending').onSnapshot(snap=>snap.docs.forEach(d=>processCommand(d.id,d.data()))));
   off.push(ref.collection('eventosV2').orderBy('revision','desc').onSnapshot(snap=>{
     const events=snap.docs.map(d=>d.data()).reverse();
     if(!baseline){events.forEach(e=>seen.add(e.id));baseline=true;return;}
     for(const e of events)if(!seen.has(e.id)){seen.add(e.id);if(api.monitor())eventQueue.push(e);}
     pumpMonitor();paint();
   }));
 }
 async function enable(){
   ensureRoom();if(!room||!isGM())throw Error('Abrir primero una sala de GM.');
   const ref=rootRef();const stRef=ref.collection('mesaV2').doc('private');const seed=R.state(id());
   const campaign=api.getState().campaign;
   if(campaign.sistemaTipo!=='dnd')throw Error('La mesa coordinada usa D&D 2014. El modo BG3 conserva su interfaz actual.');
   const saved=campaign.mesaLocalBackup;
   if(saved){if(saved.schema!==2||!Array.isArray(saved.actors)||!Array.isArray(saved.pending)||!Array.isArray(saved.order))throw Error('Estado de mesa inválido en el respaldo');Object.assign(seed,R.clone(saved),{sessionId:id(),closed:false,phase:'exploracion',activeId:null,pending:[],lastEvents:[],revision:0,restoreArchive:{events:saved.lastEvents||[],pending:saved.pending||[],reason:'Respaldo recuperado como una nueva sesión; pendientes anteriores requieren revisión'}});}
   await api.db().runTransaction(async tx=>{const old=await tx.get(stRef);if(old.exists&&!campaign.mesaImportPending)return;if(old.exists)seed.revision=old.data().revision+1;tx.set(stRef,seed);tx.set(ref.collection('mesaV2').doc('public'),R.publicState(seed));for(const a of seed.actors)tx.set(ref.collection('actoresV2').doc(a.id),a);});
   campaign.mesaImportPending=false;api.save();
   notice='Mesa coordinada activa. Incorporar las fichas de la sala para comenzar.';api.render();
 }
 async function processCommand(commandId,cmd){
   if(processing.has(commandId)||api.monitor())return;processing.add(commandId);
   const controller=room.gmUid;let failure=null;const base=rootRef();const cRef=base.collection('comandosV2').doc(commandId);const stRef=base.collection('mesaV2').doc('private');
   try{
     await api.db().runTransaction(async tx=>{
       const [stored,doc,receipt]=await Promise.all([tx.get(cRef),tx.get(stRef),tx.get(base.collection('recibosV2').doc(commandId))]);
       if(receipt.exists||!stored.exists||stored.data().status!=='pending')return;
       if(!doc.exists)throw Error('La mesa aún no está preparada');
       const result=R.reduce(doc.data(),stored.data(),stored.data().ownerUid,controller);
       tx.set(stRef,result.state);tx.set(base.collection('mesaV2').doc('public'),R.publicState(result.state));
       for(const a of result.state.actors)tx.set(base.collection('actoresV2').doc(a.id),{...a,privateRequests:result.state.pending.filter(p=>p.secret&&p.actorId===a.id).map(p=>{const q={...p};delete q.dc;return q;})});
       if(!result.event.secret)tx.set(base.collection('eventosV2').doc(commandId),result.event);
       tx.set(base.collection('recibosV2').doc(commandId),{revision:result.state.revision,at:cmd.time});
       tx.update(cRef,{status:'accepted',revision:result.state.revision});
     });
   }catch(e){failure=e.message;await cRef.update({status:'rejected',error:e.message}).catch(()=>{});notice=e.message;paint();}
   finally{processing.delete(commandId);if(pendingSubmit===commandId){pendingSubmit=null;notice=failure||'Acción confirmada y guardada';}paint();}
 }
 async function submit(command){
   if(!state)throw Error('La mesa todavía no está disponible');if(!online)throw Error('Sin conexión. El borrador se conserva; reintentar al reconectar.');
   if(pendingSubmit)throw Error('Hay un envío pendiente de confirmación; no se repetirá el comando.');
   const cmd={...command,id:command.id||id(),ownerUid:api.uid(),sessionId:state.sessionId,expectedPhase:state.phase,status:'pending',time:new Date().toISOString()};
   if(state.phase==='combate'&&!['check','respond','save','reaction','concentration'].includes(cmd.type))cmd.turnId=state.turnId;
   pendingSubmit=cmd.id;
   try{await rootRef().collection('comandosV2').doc(cmd.id).set(cmd);}catch(e){pendingSubmit=null;throw e;}
   if(pendingSubmit===cmd.id)notice=isGM()?'Resolviendo…':'Enviada al GM. Si no está conectado, queda pendiente.';paint();
 }
 function projectOwnCharacter(){
   if(api.monitor()||!privateState)return;const s=api.getState();if(!s)return;
   for(const a of privateState.actors||[]){if(a.ownerUid!==api.uid()||a.type!=='pj')continue;const c=s.chars.find(c=>c.id===a.characterId);if(!c)continue;
     c.pvActual=a.hp;const sameLevel=R.n(c.nivel)===a.level;if(sameLevel)c.pvMax=a.max;c.dnd=c.dnd||{};c.dnd.pgTemporales=a.temp;if(sameLevel)c.dnd.espaciosConjuro=R.clone(a.slots);else {c.dnd.espaciosConjuro=c.dnd.espaciosConjuro||{};for(const [level,slot] of Object.entries(a.slots))if(c.dnd.espaciosConjuro[level])c.dnd.espaciosConjuro[level].gastados=slot.gastados;}c.dnd.dadosGolpeGastados=String(a.dnd.dadosGolpeGastados||0);if(a.dnd.recursosClaseUsados)c.dnd.recursosClaseUsados=R.clone(a.dnd.recursosClaseUsados);c.dnd.muerteExitos=Array.from({length:3},(_,i)=>i<a.death.success);c.dnd.muerteFallos=Array.from({length:3},(_,i)=>i<a.death.fail);c.dnd.mesaConcentracion=a.concentration||null;
   }
 }
 function saveDrafts(){const root=document.querySelector('[data-k4-root]');if(!root)return null;return {actorId:val('actor'),fields:[...root.querySelectorAll('input[id]:not([type="hidden"]),select[id],textarea[id]')].map(e=>({id:e.id,value:e.value,checked:e.checked})),focus:root.contains(document.activeElement)?{id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null,scroll:window.scrollY};}
 function restoreDrafts(d){if(!d||d.actorId!==val('actor'))return;for(const f of d.fields){const e=document.getElementById(f.id);if(e){if(e.tagName!=='SELECT'||[...e.options].some(o=>o.value===f.value))e.value=f.value;if(e.type==='checkbox')e.checked=f.checked;}}const e=d.focus&&document.getElementById(d.focus.id);if(e){e.focus({preventScroll:true});if(typeof e.setSelectionRange==='function'&&d.focus.start!=null)try{e.setSelectionRange(d.focus.start,d.focus.end);}catch{}}window.scrollTo(0,d.scroll);}
 function paint(){
   if(api?.monitor()){paintMonitor();return;}
   const el=document.querySelector('[data-k4-root]');if(!el){if(state&&!isGM()&&!api.overlay())api.render();return;}
   const draft=saveDrafts();el.innerHTML=isGM()?gmContent():playerContent();restoreDrafts(draft);updateForm();restoreDrafts(draft);
 }
 function header(){return `<div class="k4-context"><div><strong>${escape(state.scene)}</strong><span>${state.phase==='combate'?'Ronda '+state.round+' · turno de '+escape(state.actors.find(a=>a.id===state.activeId)?.name||'—'):escape(state.phase)} · D&D 2014</span></div><span role="status">${online?'● Sincronizado':'○ Sin conexión · borradores conservados'}</span></div>`;}
 function roster(gm=false){const ordered=state.phase==='combate'?state.order.map(id=>state.actors.find(a=>a.id===id)).filter(Boolean):state.actors;return `<div class="k4-roster">${ordered.map(a=>`<button type="button" class="k4-actor ${a.id===state.activeId?'active':''} ${a.id===selected?'selected':''}" data-k4="select" data-id="${escape(a.id)}"><strong>${escape(a.name)}</strong><span>${a.hp}/${a.max} PV${a.temp?' · '+a.temp+' temporales':''}</span><progress max="${a.max||1}" value="${a.hp}"></progress><small>${a.dead?'Muerto':a.hp===0?'0 PV · '+(a.death.stable?'estable':'muerte '+a.death.success+'/'+a.death.fail):escape(a.conditions.join(' · ')||'En pie')}</small><small>${a.initiative!=null?'Iniciativa '+a.initiative:''}</small></button>`).join('')}</div>`;}
 function pendingHTML(gm){
   const pendings=gm?state.pending:[...state.pending,...mine().flatMap(a=>a.privateRequests||[])];
   return `<section class="k4-card"><h3>Pendientes (${pendings.length})</h3>${pendings.map(p=>{
     const a=state.actors.find(a=>a.id===p.actorId);const own=a?.ownerUid===api.uid();
     let controls='';
     if(p.kind==='check'&&(gm||own))controls+=btn('respond','Responder con mi ficha',`data-id="${p.id}" data-actor="${escape(p.actorId)}"`);
     if(p.kind==='area')for(const targetId of p.targets){const t=state.actors.find(a=>a.id===targetId);if(gm||t?.ownerUid===api.uid())controls+=p.responses[targetId]?`<span>${escape(t.name)}: ${p.responses[targetId].total}</span>`:btn('save','Salvación de '+escape(t?.name),`data-id="${p.id}" data-actor="${escape(targetId)}"`);}
     for(const targetId of new Set([p.targetId,...(p.targets||[])].filter(Boolean))){
       const t=(privateState?.actors||[]).find(a=>a.id===targetId);
       if(t&&(gm||t.ownerUid===api.uid())&&!t.economy.reaction&&(t.dnd.conjuros||[]).some(c=>c.nombre==='Escudo')&&['attack','spellAttack','missile'].includes(p.kind))controls+=btn('shield','Reaccionar: Escudo',`data-id="${p.id}" data-actor="${escape(targetId)}"`);
     }
     if(gm&&p.kind!=='check')controls+=btn('resolve','Confirmar consecuencias',`data-id="${p.id}"`);
     if(gm)controls+=btn('cancel','Cancelar con motivo',`data-id="${p.id}"`);
     return `<article class="k4-pending"><strong>${escape(a?.name)} · ${escape(p.label)}</strong><p>${escape(p.text||p.description||'Ventana de respuesta abierta. El GM confirma cuando todos hayan respondido.')}</p>${p.roll?`<p>${escape(p.roll.detail||'')} = ${p.roll.total}</p>`:''}<div class="row wrap">${controls}</div></article>`;
   }).join('')||'<p>Sin resoluciones pendientes.</p>'}</section>`;
 }
 function actorDetails(a,gm){if(!a)return '<p>Seleccionar un personaje o enemigo.</p>';const p=(privateState?.actors||[]).find(p=>p.id===a.id)||a;return `<section class="k4-card">${a.image?`<div class="k4-portrait"><img src="${escape(a.image)}" alt="Retrato de ${escape(a.name)}"></div>`:''}<h3>${escape(a.name)}</h3><p>CA ${a.ac}${a.shield?' + 5 (Escudo)':''} · ${a.speed} pies · iniciativa ${a.initiative??'pendiente'}</p><div class="k4-statline">${Object.entries(p.stats||{}).map(([k,v])=>`<span>${escape(k.toUpperCase())} ${v} (${R.mod(v)>=0?'+':''}${R.mod(v)})</span>`).join('')}</div><p>${escape(a.conditions.join(' · ')||'Sin condiciones')}${a.concentration?' · Concentración: '+escape(a.concentration.name):''}</p><p>Acción ${a.economy.action?'usada':'disponible'} · adicional ${a.economy.bonus?'usada':'disponible'} · reacción ${a.economy.reaction?'usada':'disponible'} · ataques restantes ${a.economy.attacks} · movimiento ${a.economy.movement}/${a.speed}</p>
     ${a.concentrationCheck?btn('concentration','Concentración · CD '+a.concentrationCheck.dc,`data-actor="${escape(a.id)}"`):''}
     ${a.hp===0&&!a.dead&&!a.death.stable?btn('death','Salvación contra muerte',`data-actor="${escape(a.id)}"`):''}
     ${!gm&&state.phase!=='combate'?btn('rollInitiative','Tirar iniciativa',`data-actor="${escape(a.id)}"`):''}${gm?`<div class="row wrap">${btn('initiative','Iniciativa manual',`data-actor="${escape(a.id)}"`)}${btn('adjust','Corregir PV con motivo',`data-actor="${escape(a.id)}"`)}${btn('condition','Aplicar/quitar condición',`data-actor="${escape(a.id)}"`)}${btn('defenses','Configurar defensas / ataques',`data-actor="${escape(a.id)}"`)}${btn('shortRest','Descanso corto',`data-actor="${escape(a.id)}"`)}${btn('longRest','Descanso largo',`data-actor="${escape(a.id)}"`)}${btn('sync','Actualizar ficha aprobada',`data-actor="${escape(a.id)}"`)}${a.type==='pj'?btn('bind','Asignar control a un jugador',`data-actor="${escape(a.id)}"`):''}</div>`:''}
     ${gm&&p.monster?`<details><summary>Ficha privada del enemigo</summary><p>${escape(Array.isArray(p.monster.rasgos)?p.monster.rasgos.map(x=>typeof x==='string'?x:[x.nombre,x.descripcion].filter(Boolean).join(': ')).join(' · '):p.monster.rasgos||'')}</p>${(p.monster.acciones||[]).map((x,i)=>`<article><strong>${escape(x.nombre)}</strong><p>${escape(x.descripcion)}</p>${btn('npc-action','Preparar esta acción',`data-index="${i}" data-actor="${escape(a.id)}"`)}</article>`).join('')}</details>`:''}
     ${p.slots?`<p>Espacios: ${Object.entries(p.slots).filter(([k,e])=>R.n(e.total)>0).map(([k,e])=>`Nv. ${k}: ${Math.max(0,R.n(e.total)-R.n(e.gastados))}/${e.total}`).join(' · ')||'—'}</p>`:''}
   </section>`;}
 function actionForm(a){if(!a)return '';const own=(privateState?.actors||[]).find(x=>x.id===a.id)||a;const active=state.phase!=='combate'||state.activeId===a.id;return `<section class="k4-card"><h3>${state.phase==='combate'?'Acciones de '+escape(a.name):'¿Qué querés hacer?'}</h3>
   ${!active?'<p>Turno ajeno: podés consultar la ficha, responder solicitudes o preparar una declaración.</p>':''}
   <form id="k4-form"><input type="hidden" id="k4-actor" value="${escape(a.id)}"><label>Acción <select id="k4-kind"><option value="check">Prueba / habilidad</option><option value="attack">Ataque de arma</option><option value="spell">Conjuro de la ficha</option><option value="declare">Proponer acción / objeto / rasgo / ritual</option><option value="action">Correr / retirarse / esquivar</option><option value="move">Movimiento</option></select></label>
   <label>Nombre o intención <input id="k4-label" placeholder="Buscar pistas, espadazo…"></label>
   <label>Objetivo <select id="k4-target">${options(state.actors)}</select></label>
   <div class="k4-fields"><label>Atributo <select id="k4-attribute">${Object.entries(attrNames).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>Ventaja <select id="k4-adv"><option value="0">Normal (ventaja y desventaja se cancelan)</option><option value="1">Ventaja</option><option value="-1">Desventaja</option></select></label><label>Bono autorizado <input id="k4-bonus" type="number" value="0"></label></div>
   <label>Arma <select id="k4-weapon"><option value="">Manual / enemigo</option>${(own.dnd?.armas||[]).filter(x=>x.nombre&&x.dano&&x.tipo!=='escudo').map((w,i)=>`<option value="${i}">${escape(w.nombre)} · ${escape(w.dano)}</option>`).join('')}</select></label>
   <label>Conjuro <select id="k4-spell">${(own.dnd?.conjuros||[]).filter(x=>x.nombre).map((c,i)=>`<option value="${i}">${escape(c.nombre)} · nivel ${escape(c.nivel)}</option>`).join('')}</select></label>
   <div class="k4-fields"><label>Espacio <input type="number" id="k4-level" min="0" max="9" value="1"></label><label>Daño / curación <input id="k4-formula" value="1d6+2"></label><label>Tipo de daño <input id="k4-damageType" value="contundente"></label></div>
   <label>Objetivos múltiples / reparto de Proyectil Mágico <input id="k4-targets" placeholder="Dejar vacío para objetivo único"></label><p class="mini">Para Proyectil Mágico se elige un objetivo por dardo. Para áreas se solicitan salvaciones individuales. El GM confirma alcance, componentes y geometría.</p>
   <div id="k4-projectiles"></div><label>Recurso de clase para la propuesta<select id="k4-resource"><option value="">Ninguno</option>${(own.resources||[]).map(r=>`<option value="${escape(r.clave)}">${escape(r.nombre)} · ${Math.max(0,r.maximo-r.usados)} disponibles</option>`).join('')}</select></label>
   <label>Declaración detallada <textarea id="k4-text" rows="2" placeholder="Intención, condiciones de un rasgo, desencadenante de Preparar…"></textarea></label>
   <label>Coste de propuesta <select id="k4-cost"><option value="action">Acción</option><option value="bonus">Acción adicional</option><option value="reaction">Reacción</option><option value="free">Sin coste de turno (fuera de combate / decisión GM)</option></select></label>
   <button class="btn primary" type="submit" ${pendingSubmit?'disabled':''}>${pendingSubmit?'Esperando confirmación…':'Declarar / tirar'}</button></form>
   <p class="mini">Una tirada libre no gasta acción. Las habilidades que representan Buscar, Esconderse u otra acción en combate se proponen al GM para confirmar su coste. No se automatizan efectos ambiguos.</p>
 </section>`;}
 function history(){return `<details class="k4-card"><summary>Historial de sesión</summary>${(state.lastEvents||[]).slice().reverse().map(e=>`<article><strong>${escape(e.actor)} · ${escape(e.label)}</strong><p>${escape(e.text)}</p>${e.roll?`<p>${escape(e.roll.detail||'')} = ${e.roll.total}</p>`:''}${e.changes.map(c=>`<p>${escape(state.actors.find(a=>a.id===c.actorId)?.name)}: ${c.before} → ${c.after}${c.tempBefore?' · temporales '+c.tempBefore+' → '+c.tempAfter:''}</p>`).join('')}</article>`).join('')}</details>`;}
 function gmContent(){
   if(!state)return `<section class="k4-card"><h2>Mesa coordinada</h2><p>Activá la mesa D&D 2014 para utilizar resoluciones compartidas, respuestas y monitor con cola de eventos.</p>${btn('enable','Activar mesa coordinada')}</section>`;
   const a=state.actors.find(a=>a.id===selected)||state.actors.find(a=>a.id===state.activeId)||state.actors[0];
   return `${header()}<p class="k4-notice" role="status">${escape(notice)}</p><div class="row wrap k4-toolbar">${btn('incorporate','Incorporar fichas de la sala')}${btn('npc','Agregar enemigo')}${btn('phase','Cambiar escena / fase')}${btn('start','Comenzar encuentro')}${btn('next','Siguiente turno','',state.phase!=='combate')}<a class="btn tiny" href="${escape(location.origin+location.pathname+'?gm='+encodeURIComponent(room.gmUid)+'&camp='+encodeURIComponent(room.campId)+'#pantalla')}" target="_blank" rel="noopener">Abrir monitor</a>${btn('export','Respaldo de sesión')}${btn('close',state.closed?'Reabrir sesión':'Cerrar sesión')}</div>${roster(true)}<div class="k4-columns"><div>${actorDetails(a,true)}${actionForm(a)}</div><div>${pendingHTML(true)}<section class="k4-card"><h3>Solicitar una tirada</h3><label>Personaje<select id="k4-requestActor">${options(state.actors.filter(a=>a.type==='pj'),a?.id)}</select></label><label>Atributo<select id="k4-requestAttr">${Object.entries(attrNames).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>${btn('request','Pedir prueba / salvación')}</section>${history()}</div></div>`;
 }
 function playerContent(){if(!state)return '<p>Esperando que el GM active la mesa coordinada.</p>';const a=mine().find(a=>a.id===selected)||mine()[0];if(!a)return '<p>El GM debe incorporar tu ficha a la mesa. Podés seguir consultando tu ficha completa.</p>';return `${header()}<p class="k4-notice" role="status">${escape(notice)}</p>${roster()}${actorDetails(a,false)}${pendingHTML(false)}${actionForm(a)}${btn('end','Proponer fin de turno')}${history()}`;}
 function available(){return !!state;}
 function updateForm(){
   const form=document.getElementById('k4-form');if(!form||!state)return;const kind=val('kind');
   const groups={actor:['check','attack','spell','declare','action','move'],kind:['check','attack','spell','declare','action','move'],label:['check','attack','declare'],target:['attack','spell','declare'],attribute:['check'],adv:['check','attack','spell'],bonus:['check','attack'],weapon:['attack'],spell:['spell'],level:['spell'],formula:['attack'],damageType:['attack'],targets:[],text:['declare','spell'],cost:['declare'],resource:['declare']};
   for(const [name,kinds] of Object.entries(groups)){const node=document.getElementById('k4-'+name);const label=node?.closest('label');if(label)label.hidden=!kinds.includes(kind);}
   const a=currentActor(val('actor'));const spell=(a?.dnd?.conjuros||[]).filter(x=>x.nombre)[R.n(val('spell'))];const box=document.getElementById('k4-projectiles');
   if(kind==='spell'&&spell?.nombre==='Proyectil Mágico'){
     const count=2+Math.max(1,Math.min(9,Math.floor(R.n(val('level'),1))));
     if(box.dataset.count!==String(count)){const old={};box.querySelectorAll('select').forEach(e=>old[e.id]=e.value);box.innerHTML='<p>Repartí los '+count+' proyectiles. Se tira una vez 1d4+1 y se aplica ese daño a cada dardo; Escudo puede impedirlo.</p>'+Array.from({length:count},(_,i)=>`<label>Proyectil ${i+1}<select id="k4-dart-${i}">${options(state.actors,old['k4-dart-'+i]||val('target'))}</select></label>`).join('');box.dataset.count=String(count);}
   }else {box.innerHTML='';delete box.dataset.count;}
 }
 function shell(){ensureRoom();return '<div data-k4-root class="k4-mesa">'+(isGM()?gmContent():playerContent())+'</div>';}
 function askDialog(message,initial='',confirmation=false){return new Promise((resolve,reject)=>{
 const previous=document.activeElement;const overlay=document.createElement('div');overlay.className='k4-dialog-backdrop';
 overlay.innerHTML=`<section class="k4-dialog" role="dialog" aria-modal="true" aria-labelledby="k4-dialog-label"><form><h2 id="k4-dialog-label">${escape(message)}</h2>${confirmation?'':`<input id="k4-dialog-value" aria-labelledby="k4-dialog-label" value="${escape(initial)}" autocomplete="off">`}<div><button type="button" data-dialog-cancel>${confirmation?'No':'Cancelar'}</button><button type="submit">${confirmation?'Sí':'Continuar'}</button></div></form></section>`;
 const numeric=/^(PV máximos|Clase de armadura|Iniciativa;|Cambio de PV|Nivel del espacio|Dados de golpe|Hora acumulada|Distancia en pies|Bono adicional|Ataques por acción|CD;)/.test(message);const finish=(value,cancel=false)=>{overlay.remove();previous?.isConnected&&previous.focus();if(cancel)reject(Error('Operación cancelada'));else resolve(value);};
 overlay.querySelector('form').onsubmit=e=>{e.preventDefault();const input=overlay.querySelector('input');if(input&&numeric&&!(message.startsWith('CD;')&&input.value.trim()==='')&&!/^-?\d+$/.test(input.value.trim())){input.setCustomValidity('Introducí un número entero válido.');input.reportValidity();input.oninput=()=>input.setCustomValidity('');return;}finish(confirmation?true:input.value);};
 overlay.querySelector('[data-dialog-cancel]').onclick=()=>finish(false,!confirmation);
 overlay.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();finish(false,!confirmation);}if(e.key==='Tab'){const nodes=[...overlay.querySelectorAll('input,button')];if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0].focus();}}};
 document.body.append(overlay);const input=overlay.querySelector('input');(input||overlay.querySelector('button[type=submit]')).focus();input?.select();
 });}
 async function valuePrompt(message,initial=''){return askDialog(message,initial);}
 async function confirmPrompt(message){return askDialog(message,'',true);}
 function currentActor(actorId){return (privateState?.actors||[]).find(a=>a.id===actorId)||state.actors.find(a=>a.id===actorId);}
 async function formSubmit(){
   const a=currentActor(val('actor'));const type=val('kind');let cmd={type,actorId:a.id,label:val('label')};const target=val('target');const adv=R.n(val('adv'));const bonus=R.n(val('bonus'));
   if(type==='check'){const attr=val('attribute');cmd.check=cmd.label.toLowerCase()==='iniciativa'?'initiative':null;cmd.roll=R.d20(R.mod(a.stats?.[attr])+bonus,adv);}
   else if(type==='declare'){cmd.text=val('text')||cmd.label;cmd.cost=val('cost');cmd.targets=[target];cmd.resource=val('resource')||null;}
   else if(type==='move'){cmd.distance=R.n(await valuePrompt('Distancia en pies. La mesa confirma la posición y el alcance.','10'));}
   else if(type==='action'){const k=await valuePrompt('Acción: correr, retirarse o esquivar','esquivar');cmd.kind=({correr:'dash',retirarse:'disengage',esquivar:'dodge'})[k];if(!cmd.kind)throw Error('Usar una acción de las indicadas');cmd.label=k;}
   else if(type==='attack'){
     const weapon=val('weapon')===''?null:(a.dnd?.armas||[]).filter(x=>x.nombre&&x.dano&&x.tipo!=='escudo')[R.n(val('weapon'),-1)];const formula=weapon?.dano?String(weapon.dano).match(/\d*d\d+(?:\s*[+-]\s*\d+)*/i)?.[0]:val('formula');
     cmd.targetId=target;cmd.label=weapon?.nombre||cmd.label||'Ataque';cmd.roll=R.d20(weapon?R.n(weapon.bonifAtaque):bonus,adv);cmd.damageRoll=R.roll(formula||val('formula'),Math.random,cmd.roll.natural===20);cmd.damageType=val('damageType');
   }else if(type==='spell'){
     const spell=(a.dnd?.conjuros||[]).filter(x=>x.nombre)[R.n(val('spell'))];if(!spell)throw Error('Seleccionar un conjuro de la ficha');
     const meta=api.spellMeta(spell.nombre)||{};const base=R.n(parseInt(spell.nivel,10));const level=base?R.n(val('level')):0;
     cmd={...cmd,label:spell.nombre,baseLevel:base,level,targets:[target],description:meta.efecto||spell.descripcion||'',concentration:!!meta.concentracion,cost:/adicional/i.test(meta.tiempo)?'bonus':/reacción/i.test(meta.tiempo)?'reaction':'action'};
     if(meta.ritual&&/ritual/i.test(val('text'))){cmd.type='declare';cmd.text='Ritual: '+spell.nombre+' · '+val('text');cmd.cost='free';return submit(cmd);}
     if(cmd.cost==='reaction')throw Error('Declarar la reacción desde su desencadenante; Escudo está en la bandeja de pendientes.');
     if(spell.nombre==='Proyectil Mágico'){
       cmd.magicMissile=true;cmd.targets=[];for(let i=0;i<2+level;i++){const picked=val('dart-'+i,target);if(!state.actors.some(a=>a.id===picked))throw Error('Repartir todos los proyectiles');cmd.targets.push(picked);}cmd.roll=R.roll('1d4+1');cmd.damageType='fuerza';
     }else if(['Curar Heridas','Palabra de Curación'].includes(spell.nombre)){cmd.healing=true;cmd.roll=R.roll(`${level}d${spell.nombre==='Curar Heridas'?8:4}${R.n(a.dnd.modAptitudMagica)>=0?'+':''}${R.n(a.dnd.modAptitudMagica)}`);}
     else if(['Rayo de Fuego','Descarga de Fuego','Rayo de Escarcha','Infligir Heridas'].includes(spell.nombre)){
       cmd.attack=true;cmd.roll=R.d20(R.n(a.dnd.bonifAtaqueConjuros),adv);const formula=spell.nombre==='Infligir Heridas'?`${level+2}d10`:spell.nombre==='Rayo de Escarcha'?`${a.level>=17?4:a.level>=11?3:a.level>=5?2:1}d8`:`${a.level>=17?4:a.level>=11?3:a.level>=5?2:1}d10`;cmd.damageRoll=R.roll(formula,Math.random,cmd.roll.natural===20);cmd.damageType=spell.nombre==='Infligir Heridas'?'necrótico':spell.nombre==='Rayo de Escarcha'?'frío':'fuego';
     }else if(/Bola de Fuego|Manos Ardientes|Rayo Llameante/.test(spell.nombre)){
       const choices=state.actors.map((a,j)=>`${j+1}: ${a.name}`).join('\n');const picked=await valuePrompt('Objetivos del área, números separados por comas. Confirmar geometría con el GM.\n'+choices,'1');cmd.targets=picked.split(',').map(v=>state.actors[R.n(v)-1]?.id);if(cmd.targets.some(x=>!x))throw Error('Objetivos inválidos');cmd.save=true;cmd.attribute='des';cmd.dc=R.n(a.dnd.cdSalvacionConjuros);cmd.half=true;cmd.roll=R.roll(spell.nombre==='Bola de Fuego'?`${8+Math.max(0,level-3)}d6`:`${3+Math.max(0,level-1)}d6`);cmd.damageType='fuego';
     }else {cmd.type='declare';cmd.text='Conjuro asistido: '+spell.nombre+' · '+cmd.description+' · espacio propuesto '+level+' · '+val('text');cmd.spell={level,baseLevel:base,concentration:!!meta.concentracion};notice='El GM confirmará espacios, concentración y efectos particulares; no se automatiza una fórmula genérica.';}
   }
   await submit(cmd);
 }
 async function click(action,button){
   const actorId=button.dataset.actor;const a=actorId?currentActor(actorId):null;const pending=[...(state?.pending||[]),...mine().flatMap(a=>a.privateRequests||[])].find(p=>p.id===button.dataset.id);
   switch(action){
     case 'enable':return enable();
     case 'select':selected=button.dataset.id;paint();return;
     case 'incorporate':{const own=api.getState().chars.map(c=>buildActor(c,api.uid()));const connected=roomPlayers().filter(j=>j.personaje?.id).map(j=>buildActor(j.fichaMesa?{...j.fichaMesa,imagen:j.personaje.imagen}:j.personaje,j.id));return submit({type:'add',actors:[...own,...connected]});}
     case 'npc':{
       const name=await valuePrompt('Nombre del enemigo (o nombre exacto del bestiario)','Goblin');const m=api.monsters().find(m=>m.nombre.toLowerCase()===name.toLowerCase());
       const hp=m?R.n(m.pg):R.n(await valuePrompt('PV máximos','20'));const ac=m?R.n(m.ca||m.defensa,10):R.n(await valuePrompt('Clase de armadura','12'));
       const c={id:id(),nombre:name,pvActual:hp,pvMax:hp,defensa:ac,nivel:1,stats:m?.atributos||{}};const x=R.actor(c,room.gmUid,'npc');if(m){x.monster=R.clone(m);x.monsterId=m.id;x.image=m.imagenUrl||'';x.speed=R.n(parseInt(m.velocidad?.caminando,10),0);x.saves={};for(const [key,name] of Object.entries(attrNames))x.saves[key]=R.n(m.salvaciones?.[name],R.mod(x.stats[key]));}return submit({type:'add',actors:[x]});
     }
     case 'npc-action':{
       const m=a.monster;const x=m.acciones[R.n(button.dataset.index)];const parsed=api.parseMonster(x.descripcion);
       selected=a.id;paint();document.getElementById('k4-actor').value=a.id;document.getElementById('k4-label').value=x.nombre;document.getElementById('k4-text').value=x.descripcion;
       if(parsed?.bonusAtaque!=null){document.getElementById('k4-kind').value='attack';document.getElementById('k4-bonus').value=parsed.bonusAtaque;document.getElementById('k4-formula').value=parsed.nd?`${parsed.nd.cantidad}d${parsed.nd.caras}${parsed.nd.mod>=0?'+':''}${parsed.nd.mod}`:'1d6';document.getElementById('k4-damageType').value=/de daño ([a-záéíóúñ]+)/i.exec(x.descripcion)?.[1]||'sin tipo';}else document.getElementById('k4-kind').value='declare';updateForm();return;
     }
     case 'phase':return submit({type:'phase',phase:await valuePrompt('Fase: exploracion, social o preparacion','exploracion'),scene:await valuePrompt('Nombre público de la escena',state.scene)});
     case 'start':{const missing=state.actors.filter(a=>a.initiative==null);if(missing.length)throw Error('Falta iniciativa: '+missing.map(a=>a.name).join(', '));return submit({type:'start'});}
     case 'next':return submit({type:'next'});
     case 'rollInitiative':return submit({type:'check',actorId,check:'initiative',label:'Iniciativa',roll:R.d20(R.mod(a.stats?.des))});
     case 'initiative':return submit({type:'initiative',actorId,value:R.n(await valuePrompt('Iniciativa; resolver empates con el GM','10'))});
     case 'adjust':return submit({type:'adjust',actorId,delta:R.n(await valuePrompt('Cambio de PV: negativo daña, positivo cura','-3')),reason:await valuePrompt('Motivo de corrección'),damageType:await valuePrompt('Tipo de daño, si corresponde','sin tipo')});
     case 'condition':return submit({type:'condition',actorId,condition:await valuePrompt('Condición exacta','Envenenado'),remove:await confirmPrompt('¿Quitar la condición? Cancelar significa aplicarla.')});
     case 'defenses':return submit({type:'configure',actorId,resistances:(await valuePrompt('Resistencias, separadas por comas',(a.resistances||[]).join(','))).split(',').map(x=>x.trim()).filter(Boolean),immunities:(await valuePrompt('Inmunidades, separadas por comas',(a.immunities||[]).join(','))).split(',').map(x=>x.trim()).filter(Boolean),vulnerabilities:(await valuePrompt('Vulnerabilidades, separadas por comas',(a.vulnerabilities||[]).join(','))).split(',').map(x=>x.trim()).filter(Boolean),extraAttacks:R.n(await valuePrompt('Ataques por acción Atacar / acción compuesta autorizada',String(a.extraAttacks)))});
     case 'respond':{const x=currentActor(pending.actorId);const ownBonus=(pending.rollKind==='save'?savingBonus(x,pending.attribute):R.mod(x.stats[pending.attribute]))+R.n(pending.bonus);return submit({type:'respond',actorId:x.id,pendingId:pending.id,roll:R.d20(ownBonus)});}
     case 'save':{const p=state.pending.find(p=>p.id===button.dataset.id);return submit({type:'save',actorId:a.id,pendingId:p.id,roll:R.d20(savingBonus(a,p.attribute))});}
     case 'shield':return submit({type:'reaction',actorId,pendingId:pending.id,kind:'shield',level:R.n(await valuePrompt('Nivel del espacio para Escudo','1'))});
     case 'resolve':{
       const cmd={type:'resolve',pendingId:pending.id,reason:pending.kind==='assisted'||pending.kind==='spell'?await valuePrompt('Confirmación del GM: recursos, alcance, componentes y efectos',pending.text||pending.description||'Confirmado'):''};
       if(pending.kind==='assisted'&&await confirmPrompt('¿Aplicar un cambio de PV o condición como consecuencia de esta propuesta?')){
         const choices=state.actors.map((a,i)=>`${i+1}: ${a.name}`).join('\n');const t=state.actors[R.n(await valuePrompt('Objetivo\n'+choices,'1'))-1];if(!t)throw Error('Objetivo inválido');cmd.targetId=t.id;cmd.delta=R.n(await valuePrompt('Cambio de PV confirmado, o 0 para solo condición','0'));cmd.damageType=await valuePrompt('Tipo de daño si corresponde','sin tipo');cmd.condition=await valuePrompt('Condición; dejar vacío si no corresponde','');
       }return submit(cmd);
     }
     case 'cancel':return submit({type:'cancel',pendingId:pending.id,reason:await valuePrompt('Motivo de cancelación')});
     case 'request':return submit({type:'request',actorId:val('requestActor'),attribute:val('requestAttr'),rollKind:await valuePrompt('Tipo: prueba o salvacion (la salvación toma su bono completo de la ficha)','salvacion')==='salvacion'?'save':'check',bonus:R.n(await valuePrompt('Bono adicional autorizado; competencia ya incluida en salvaciones','0')),dc:await valuePrompt('CD; vacío si no corresponde','')||null,label:await valuePrompt('Nombre de la tirada solicitada','Salvación'),secret:await confirmPrompt('¿Mantener esta tirada privada entre GM y jugador?')});
     case 'death':return submit({type:'death',actorId,roll:R.d20()});
     case 'concentration':return submit({type:'concentration',actorId,roll:R.d20(savingBonus(a,'con'))});
     case 'shortRest':{if(!await confirmPrompt('¿La mesa confirma al menos 1 hora de descanso?'))return;const count=R.n(await valuePrompt('Dados de golpe a gastar','1'));const faces=/d(\d+)/.exec(a.dnd.dadosGolpeTotal||'1d8')?.[1]||8;return submit({type:'shortRest',actorId,diceCount:count,roll:count?R.roll(count+'d'+faces):{groups:[],total:0}});}
     case 'longRest':if(!await confirmPrompt('¿Al menos 8 horas, con sueño/actividad e interrupciones válidas?'))return;return submit({type:'longRest',actorId,fictionHour:R.n(await valuePrompt('Hora acumulada de campaña; debe haber 24 h entre descansos largos','24'))});
     case 'sync':{const j=roomPlayers().find(j=>j.id===a.ownerUid);const c=api.getState().chars.find(c=>c.id===a.characterId)||j?.fichaMesa||j?.personaje;if(!c)throw Error('No está disponible la ficha original');if(!await confirmPrompt('¿Aprobar actualización de nivel, CA, atributos y recursos de esta ficha? Los PV actuales y espacios gastados se conservan.'))return;return submit({type:'sync',actorId,character:c,resources:buildActor(c,a.ownerUid).resources});}
     case 'bind':{const players=roomPlayers().filter(j=>j.charId);const chosen=players[R.n(await valuePrompt('Elegir jugador conectado\n'+players.map((j,i)=>`${i+1}: ${j.nombreJugador} · ${j.personaje?.nombre}`).join('\n'),'1'))-1];if(!chosen)throw Error('Elegir un jugador conectado');return submit({type:'bind',actorId,ownerUid:chosen.id,characterId:chosen.charId,reason:await valuePrompt('Motivo de reasignación','Reconexión de una ficha restaurada')});}
     case 'end':return submit({type:'declare',actorId:val('actor',mine()[0]?.id),text:'Propongo terminar mi turno',cost:'free',label:'Fin de turno propuesto'});
     case 'close':return submit({type:state.closed?'reopen':'close',newSessionId:id()});
     case 'export':{const full=R.clone(api.getState());full.campaign.mesaLocalBackup=R.clone(privateState);const blob=new Blob([JSON.stringify(full,null,2)],{type:'application/json'});const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download='k4-respaldo-sesion.json';a.click();setTimeout(()=>URL.revokeObjectURL(href),10000);return;}
     case 'monitor':window.open(location.origin+location.pathname+'?gm='+encodeURIComponent(room.gmUid)+'&camp='+encodeURIComponent(room.campId)+'#pantalla','_blank');return;
   }
 }
 function pumpMonitor(){if(!api.monitor()||showing||monitorPaused||!eventQueue.length)return;showing=eventQueue.shift();const critical=showing.changes.some(c=>c.after===0)||showing.type==='death';const words=String(showing.text).split(/\s+/).length;const duration=critical?Math.max(8000,words*330):eventQueue.length>=3?Math.max(4000,words*330):showing.changes.length?Math.max(8000,words*330):Math.max(5500,words*330);paintMonitor();monitorTimer=setTimeout(()=>{showing=null;paintMonitor();pumpMonitor();},duration);}
 function monitorDice(roll){
   const values=roll.faces?roll.faces.map((v,i)=>({faces:20,value:v,kept:roll.faces.indexOf(roll.natural)===i})):roll.groups?.flatMap(g=>(g.values||[]).map(value=>({faces:g.faces,value,kept:true})))||[];
   return `<div class="k4-dice-row">${values.map(d=>`<div class="k4-die ${d.faces===20?'d20':d.faces===4?'d4':'d6'} ${d.kept?'kept':'discarded'}"><small>d${d.faces}</small><strong>${d.value}</strong></div>`).join('')}</div><p class="k4-dice">${escape(roll.detail||'')} <strong>= ${roll.total}</strong></p>`;
 }
 function paintMonitor(){
   if(!api.monitor())return;document.body.classList.add('modo-pantalla-tv');const target=document.getElementById('pantallaTV');if(!target)return;target.hidden=false;
   if(!state){target.innerHTML='<div class="k4-monitor"><h1>Esperando la mesa del GM…</h1></div>';return;}
   const e=showing;const a=state.actors.find(a=>a.id===state.activeId);const i=state.order.indexOf(state.activeId);const next=state.actors.find(a=>a.id===state.order[(i+1)%state.order.length]);
   const eventCard=e?`<div class="k4-event" role="status"><p>Relato · acción de ronda ${e.round} · ${escape(e.actor)}</p><h1>${escape(e.label)}</h1>${e.roll?`<div class="${matchMedia('(prefers-reduced-motion: reduce)').matches?'':'reveal'}">${monitorDice(e.roll)}</div>`:''}<h2>${escape(e.text.length>280?e.text.slice(0,277)+'…':e.text)}</h2>${e.changes.map(c=>`<p>${escape(c.actorName||state.actors.find(a=>a.id===c.actorId)?.name)}: <strong>${c.before} → ${c.after} PV</strong>${c.tempBefore?' · temporales '+c.tempBefore+' → '+c.tempAfter:''}</p>`).join('')}</div>`:'';
   if(!document.getElementById('k4-live'))target.innerHTML='<main class="k4-monitor"><section id="k4-live"></section><section id="k4-story"></section><footer id="k4-recent"></footer></main>';
   target.querySelector('.k4-monitor').classList.toggle('k4-many',state.actors.length>12);
   document.getElementById('k4-live').innerHTML=`<header><h1>${escape(state.scene)}</h1><p>${state.phase==='combate'?'Ronda '+state.round+' · turno vigente: '+escape(a?.name):escape(state.phase)}${next&&state.phase==='combate'?' · siguiente: '+escape(next.name):''}</p><small>${online?'En vivo':'Conexión perdida · último estado conocido'}${eventQueue.length?' · '+eventQueue.length+' acciones en relato':''}</small></header>${roster()}${state.actors.some(a=>a.hp===0)?`<aside class="k4-critical">${state.actors.filter(a=>a.hp===0).map(a=>escape(a.name)+(a.dead?' · muerto':a.death.stable?' · estable':' · 0 PV')).join(' | ')}</aside>`:''}<section class="k4-public-pending">${state.pending.length?'Resoluciones pendientes: '+state.pending.map(p=>escape(p.label)).join(' · '):'La mesa está lista para continuar'}</section>`;
   const story=document.getElementById('k4-story');if(story.dataset.event!==(e?.id||'')){story.dataset.event=e?.id||'';story.innerHTML=eventCard;}
   document.getElementById('k4-recent').innerHTML='Últimas acciones: '+state.lastEvents.slice(-3).map(e=>escape(e.actor)+' · '+escape(e.label)).join(' | ');
 }
 async function startMonitor(user){const params=new URLSearchParams(location.search);let gmUid=params.get('gm'),campId=params.get('camp');if(!gmUid||!campId){const campaign=await api.db().collection('campanias').doc(user.uid).get();gmUid=user.uid;campId=campaign.data()?.activa;if(!campId)return false;const projection=await api.db().collection('campanias').doc(gmUid).collection('lista').doc(campId).collection('mesaV2').doc('public').get();if(!projection.exists)return false;window.history.replaceState(null,'',location.pathname+'?gm='+encodeURIComponent(gmUid)+'&camp='+encodeURIComponent(campId)+'#pantalla');}api.setUid(user.uid);document.getElementById('loginScreen').hidden=true;document.getElementById('verifyScreen').hidden=true;document.getElementById('appScreen').hidden=true;attach({gmUid,campId});return true;}
 function install(context){api=context;document.addEventListener('click',e=>{const b=e.target.closest('[data-k4]');if(!b||api.monitor())return;e.preventDefault();e.stopImmediatePropagation();Promise.resolve(click(b.dataset.k4,b)).catch(err=>{notice=err.message;paint();});},true);document.addEventListener('change',e=>{if(e.target.closest('#k4-form'))updateForm();});document.addEventListener('submit',e=>{if(e.target.id!=='k4-form')return;e.preventDefault();e.stopImmediatePropagation();formSubmit().catch(err=>{notice=err.message;paint();});},true);window.addEventListener('online',()=>{online=true;paint();});window.addEventListener('offline',()=>{online=false;paint();});}
 window.K4Mesa={roomPlayers,install,shell,paint,updateForm,ensureRoom,available,startMonitor,projectOwnCharacter,saveDrafts,restoreDrafts,getState:()=>isGM()?privateState:state?{...state,actors:state.actors.map(a=>privateState?.actors.find(p=>p.id===a.id)||a)}:null,detach};
})();
