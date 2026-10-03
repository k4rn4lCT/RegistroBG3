(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.K4Rules=api;})(globalThis,function(){
  'use strict';
  const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
  const clone=v=>JSON.parse(JSON.stringify(v));
  const mod=v=>Math.floor((n(v,10)-10)/2);
  const requireRule=(ok,message)=>{if(!ok)throw new Error(message);};
  function parse(s){
    s=String(s).replace(/\s/g,'').toLowerCase();
    if(!s || !/^[+-]?(?:\d*d\d+|\d+)(?:[+-](?:\d*d\d+|\d+))*$/.test(s))throw new Error('Fórmula inválida; usar dados y modificadores completos, por ejemplo 2d6+1d4-2.');
    return s.match(/[+-]?(?:\d*d\d+|\d+)/g).map(t=>{
      const sign=t[0]==='-'?-1:1;const x=t.replace(/^[+-]/,'');
      if(x.includes('d')){const [a,b]=x.split('d');const count=n(a||1),faces=n(b);requireRule(count>=1&&count<=100&&faces>=2&&faces<=1000,'Dados fuera de rango');return {sign,count,faces};}
      const value=n(x);requireRule(value<=100000,'Modificador fuera de rango');return {sign,value};
    });
  }
  function roll(formula,rng=Math.random,critical=false){
    const groups=parse(formula).map(g=>g.faces?{...g,values:Array.from({length:g.count*(critical?2:1)},()=>1+Math.floor(rng()*g.faces))}:g);
    return {formula,groups,total:groups.reduce((s,g)=>s+g.sign*(g.values?g.values.reduce((a,b)=>a+b,0):g.value),0),detail:groups.map((g,i)=>(g.sign<0?'-':i?'+':'')+(g.values?'['+g.values.join(', ')+']':g.value)).join(' ')};
  }
  function d20(bonus=0,adv=0,rng=Math.random){
    const faces=Array.from({length:adv?2:1},()=>1+Math.floor(rng()*20));
    const natural=adv>0?Math.max(...faces):adv<0?Math.min(...faces):faces[0];
    return {formula:'1d20'+(bonus>=0?'+':'')+bonus,faces,natural,bonus,total:natural+n(bonus),detail:faces.join(' / ')+(adv>0?' (ventaja)':adv<0?' (desventaja)':'')+' '+(bonus>=0?'+':'')+bonus};
  }
  function validateRoll(r){
    if(!r)return;
    requireRule(Number.isFinite(r.total),'Resultado de tirada inválido');
    if(r.natural!=null)requireRule(Number.isInteger(r.natural)&&r.natural>=1&&r.natural<=20,'Cara natural inválida');
    if(r.faces){requireRule(Array.isArray(r.faces)&&r.faces.length>=1&&r.faces.length<=2&&r.faces.every(v=>Number.isInteger(v)&&v>=1&&v<=20),'Caras d20 inválidas');requireRule(r.faces.includes(r.natural)&&r.total===r.natural+n(r.bonus),'El resultado no coincide con las caras y el modificador');}
    if(r.groups){let total=0;for(const g of r.groups){requireRule(g.sign===1||g.sign===-1,'Signo de grupo inválido');if(g.values){requireRule(g.values.length>0&&g.values.length<=200&&g.values.every(v=>Number.isInteger(v)&&v>=1&&v<=g.faces),'Caras de daño inválidas');total+=g.sign*g.values.reduce((a,b)=>a+b,0);}else {requireRule(Number.isFinite(g.value),'Modificador de daño inválido');total+=g.sign*g.value;}}requireRule(total===r.total,'El total de daño no coincide con los dados');}
  }
  function damage(a,amount,type='sin tipo',critical=false){
    let raw=Math.max(0,n(amount));
    if((a.immunities||[]).includes(type))raw=0;
    else {if((a.resistances||[]).includes(type))raw=Math.floor(raw/2);if((a.vulnerabilities||[]).includes(type))raw*=2;}
    const before=n(a.hp),tempBefore=n(a.temp);const absorbed=Math.min(tempBefore,raw);a.temp=tempBefore-absorbed;
    const remaining=raw-absorbed;a.hp=Math.max(0,before-remaining);
    if(a.hp===0){
      if(remaining>=before+n(a.max))a.dead=true;
      else if(before===0&&remaining>0){a.death.fail+=critical?2:1;a.death.stable=false;if(a.death.fail>=3)a.dead=true;}
      else if(a.type==='pj')a.conditions=[...new Set([...(a.conditions||[]),'Inconsciente'])];
    }
    if(a.concentration&&raw>0){
      if(a.hp===0)a.concentration=null;
      else a.concentrationCheck={dc:Math.max(10,Math.floor(raw/2)),damage:raw};
    }
    return {actorId:a.id,before,after:a.hp,tempBefore,tempAfter:a.temp,raw:n(amount),resolved:raw,type};
  }
  function heal(a,amount){requireRule(!a.dead,'Un personaje muerto requiere un efecto que lo devuelva a la vida.');const before=n(a.hp);a.hp=Math.min(n(a.max),before+Math.max(0,n(amount)));if(a.hp>0){a.death={success:0,fail:0,stable:false};a.conditions=(a.conditions||[]).filter(c=>c!=='Inconsciente');}return {actorId:a.id,before,after:a.hp,healing:Math.max(0,n(amount)),actual:a.hp-before};}
  function deathSave(a,r){
    requireRule(a.hp===0&&!a.dead&&!a.death.stable,'No corresponde una salvación contra muerte.');
    if(r.natural===20){heal(a,1);return 'Recupera 1 PV';}
    if(r.natural===1)a.death.fail+=2;else if(r.total>=10)a.death.success++;else a.death.fail++;
    if(a.death.fail>=3)a.dead=true;if(a.death.success>=3)a.death.stable=true;
    return a.dead?'Muerto':a.death.stable?'Estabilizado':`${a.death.success} éxitos · ${a.death.fail} fallos`;
  }
  function actor(c,ownerUid,type='pj'){
    const d=c.dnd||{};const level=n(c.nivel,1);const cls=d._claseId||'';
    const extra=cls==='guerrero'?(level>=20?4:level>=11?3:level>=5?2:1):(['barbaro','paladin','monje','explorador'].includes(cls)&&level>=5?2:1);
    return {id:ownerUid+':'+c.id,ownerUid,characterId:c.id,name:c.nombre||'Sin nombre',type,level,classId:cls,
      hp:n(c.pvActual),max:n(c.pvMax),temp:n(d.pgTemporales),ac:n(d.claseArmadura||c.defensa,10),speed:n(parseInt(d.velocidad,10),30),image:c.imagen||'',stats:c.stats||{},
      dnd:clone(d),extraAttacks:extra,conditions:[],resistances:[],immunities:[],vulnerabilities:[],initiative:null,
      death:{success:0,fail:0,stable:false},dead:false,concentration:null,concentrationCheck:null,
      economy:{action:false,bonus:false,reaction:false,movement:0,attacks:0,bonusSpell:false,leveledSpell:false},slots:clone(d.espaciosConjuro||{})};
  }
  function state(sessionId){return {schema:2,edition:'dnd5e-2014',sessionId,revision:0,phase:'exploracion',round:1,turnId:0,activeId:null,order:[],actors:[],pending:[],lastEvents:[],scene:'Exploración',closed:false};}
  function advance(s){
    requireRule(!s.pending.some(p=>!p.optional),'Hay una resolución pendiente. Resolverla o cancelarla antes de avanzar.');
    requireRule(s.order.length,'Agregar participantes al encuentro.');
    let i=s.order.indexOf(s.activeId)+1;if(i>=s.order.length){i=0;s.round++;}s.activeId=s.order[i];s.turnId++;
    const a=s.actors.find(a=>a.id===s.activeId);a.economy={action:false,bonus:false,reaction:false,movement:0,attacks:0,bonusSpell:false,leveledSpell:false};
    a.shield=false;a.reckless=false;
    a.conditions=(a.conditions||[]).filter(c=>!['Esquivando','Desenganchado'].includes(c));
    for(const x of s.actors)if(x.effects)x.effects=x.effects.filter(e=>!(e.endsAtActor===a.id&&e.endsAtTurn<=s.turnId));
  }
  function consume(a,s,cost,kind){
    requireRule(a.hp>0&&!a.dead&&!['Inconsciente','Incapacitado','Paralizado','Aturdido','Petrificado'].some(c=>(a.conditions||[]).includes(c)),'No puede actuar en este estado.');
    if(s.phase!=='combate')return;
    requireRule(cost==='reaction'||s.activeId===a.id,'No es el turno de ese personaje.');
    const e=a.economy;
    if(cost==='attack'){
      if(!e.action){e.action=true;e.attacks=a.extraAttacks;}
      requireRule(e.attacks>0,'No quedan ataques de la acción Atacar.');e.attacks--;
    }else if(cost==='movement'){requireRule(!['Agarrado','Apresado'].some(c=>a.conditions.includes(c)),'Movimiento impedido.');}
    else if(cost&&cost!=='free'){requireRule(!e[cost],'Ese recurso ya se utilizó.');e[cost]=true;if(cost==='action')e.attacks=0;}
    if(kind==='leveledSpell'){requireRule(!e.bonusSpell,'Tras conjurar como acción adicional solo puede lanzarse un truco de una acción en este turno.');e.leveledSpell=true;}
    if(kind==='bonusSpell'){requireRule(!e.leveledSpell,'Ya se lanzó otro conjuro con nivel en este turno.');e.bonusSpell=true;}
  }
  function reduce(input,cmd,user,gmUid){
    validateRoll(cmd.roll);validateRoll(cmd.damageRoll);
    const s=clone(input);requireRule(!s.closed||cmd.type==='reopen','La sesión está cerrada.');
    requireRule(cmd.sessionId===s.sessionId,'La sala fue reemplazada.');
    const gm=user===gmUid;let a=s.actors.find(a=>a.id===cmd.actorId);const get=id=>{const x=s.actors.find(a=>a.id===id);requireRule(x,'Objetivo inexistente');return x;};
    const admin=['add','sync','bind','phase','start','next','remove','adjust','condition','resolve','cancel','close','reopen','reorder','initiative','shortRest','longRest','xp','house','configure','request'];
    if(admin.includes(cmd.type))requireRule(gm,'Solo el GM puede confirmar esta operación.');
    else requireRule(a&&(gm||a.ownerUid===user),'No controla ese personaje.');
    if(cmd.turnId!=null&&s.phase==='combate'&&!['respond','reaction','death','concentration'].includes(cmd.type))requireRule(cmd.turnId===s.turnId,'El turno cambió. Revisar la declaración.');
    if(cmd.expectedPhase!=null&&!admin.includes(cmd.type))requireRule(cmd.expectedPhase===s.phase,'La escena cambió; revisar la declaración antes de reenviarla.');
    const labels={add:'Participantes incorporados',sync:'Ficha aprobada',bind:'Control asignado',phase:'Cambio de escena',start:'Comienza el combate',next:'Turno siguiente',adjust:'Corrección de PV',condition:'Condición',request:'Solicitud de tirada',resolve:'Resolución',cancel:'Acción cancelada',configure:'Defensas y ataques',initiative:'Iniciativa',shortRest:'Descanso corto',longRest:'Descanso largo',death:'Salvación contra muerte',concentration:'Concentración',reaction:'Reacción',close:'Sesión cerrada',reopen:'Nueva sesión',move:'Movimiento',xp:'Experiencia'};
    const event={id:cmd.id,type:cmd.type,sessionId:s.sessionId,actorId:admin.includes(cmd.type)?null:a?.id||null,actor:admin.includes(cmd.type)?'GM':a?.name||'GM',label:cmd.label||labels[cmd.type]||'Acción',time:cmd.time,roll:cmd.roll||null,changes:[],text:'',turnId:s.turnId,round:s.round};
    const slot=(actor,level)=>{if(!level)return;const p=actor.slots[level];requireRule(p&&n(p.gastados)<n(p.total),'No quedan espacios de ese nivel.');p.gastados=n(p.gastados)+1;};
    switch(cmd.type){
      case 'add': for(const x of cmd.actors||[])if(!s.actors.some(a=>a.id===x.id))s.actors.push(clone(x));event.text='Participantes incorporados';break;
      case 'sync': {const x=get(cmd.actorId);x.dnd=clone(cmd.character.dnd||{});const updated=clone(x.dnd.espaciosConjuro||{});for(const [level,slot] of Object.entries(updated))slot.gastados=n(x.slots[level]?.gastados);x.slots=updated;x.level=n(cmd.character.nivel,1);x.stats=clone(cmd.character.stats||{});x.ac=n(x.dnd.claseArmadura||cmd.character.defensa,10);x.max=n(cmd.character.pvMax);x.hp=Math.min(x.hp,x.max);x.extraAttacks=actor(cmd.character,x.ownerUid).extraAttacks;if(cmd.resources)x.resources=cmd.resources;event.text='Ficha y recursos actualizados con aprobación del GM; los espacios gastados se conservan';break;}
      case 'bind':{const x=get(cmd.actorId);requireRule(cmd.ownerUid&&cmd.characterId&&cmd.reason,'Indicar cuenta, personaje y motivo');x.ownerUid=cmd.ownerUid;x.characterId=cmd.characterId;event.text='Control del personaje reasignado por el GM: '+cmd.reason;break;}
      case 'remove': requireRule(s.phase!=='combate','Cerrar el encuentro antes de retirar participantes.');s.actors=s.actors.filter(x=>x.id!==cmd.actorId);s.order=s.order.filter(id=>id!==cmd.actorId);break;
      case 'configure': a=get(cmd.actorId);for(const k of ['resistances','immunities','vulnerabilities'])if(cmd[k])a[k]=cmd[k];if(cmd.extraAttacks)a.extraAttacks=Math.max(1,Math.min(10,n(cmd.extraAttacks)));event.text='Defensas y ataques configurados por el GM';break;
      case 'phase':requireRule(['exploracion','social','preparacion','pausa','cierre'].includes(cmd.phase),'Fase inválida.');requireRule(!s.pending.length,'Resolver pendientes antes de cambiar de fase.');if(s.phase==='combate'&&cmd.phase!=='pausa'){for(const actor of s.actors){actor.shield=false;actor.reckless=false;actor.conditions=actor.conditions.filter(c=>!['Esquivando','Desenganchado'].includes(c));actor.economy={action:false,bonus:false,reaction:false,movement:0,attacks:0,bonusSpell:false,leveledSpell:false};}}s.phase=cmd.phase;s.scene=cmd.scene||s.scene;s.activeId=null;event.text=s.scene;break;
      case 'start': requireRule(s.actors.length&&s.actors.every(a=>a.initiative!=null),'Falta iniciativa de un participante.');requireRule(!s.pending.length,'Hay acciones pendientes.');s.order=s.actors.slice().sort((a,b)=>b.initiative-a.initiative).map(a=>a.id);s.phase='combate';s.round=1;s.activeId=null;advance(s);event.text='Comienza el combate';break;
      case 'next':advance(s);event.text='Turno de '+get(s.activeId).name;break;
      case 'reorder': requireRule(cmd.order.length===s.order.length&&new Set(cmd.order).size===s.order.length&&cmd.order.every(id=>s.order.includes(id)),'Orden inválido.');s.order=cmd.order;event.text='Orden corregido; el actor activo no cambia';break;
      case 'initiative':get(cmd.actorId).initiative=n(cmd.value);event.text=get(cmd.actorId).name+' · iniciativa '+n(cmd.value);break;
      case 'adjust': a=get(cmd.actorId);requireRule(cmd.reason?.trim(),'Indicar motivo de la corrección.');event.changes.push(cmd.delta<0?damage(a,-cmd.delta,cmd.damageType):heal(a,cmd.delta));event.text=cmd.reason;break;
      case 'condition': a=get(cmd.actorId);a.conditions=cmd.remove?a.conditions.filter(c=>c!==cmd.condition):[...new Set([...a.conditions,cmd.condition])];if(['Inconsciente','Incapacitado','Paralizado','Aturdido','Petrificado'].some(c=>a.conditions.includes(c)))a.concentration=null;event.text=a.name+' · '+cmd.condition+(cmd.remove?' retirada':' aplicada');break;
      case 'check':requireRule(cmd.roll&&Number.isFinite(cmd.roll.total),'Falta tirada');event.text=(cmd.label||'Prueba')+': '+cmd.roll.total;if(cmd.check==='initiative')a.initiative=cmd.roll.total;break;
      case 'request':requireRule(a,'Seleccionar actor');s.pending.push({id:cmd.id,kind:'check',actorId:a.id,ownerUid:a.ownerUid,label:cmd.label,attribute:cmd.attribute,rollKind:cmd.rollKind||'check',bonus:n(cmd.bonus),dc:cmd.dc==null?null:n(cmd.dc),secret:!!cmd.secret});event.text='Solicitud enviada a '+a.name;break;
      case 'respond':{const p=s.pending.find(p=>p.id===cmd.pendingId&&p.kind==='check');requireRule(p&&p.actorId===a.id,'Solicitud inexistente');event.label=p.label;event.roll=cmd.roll;event.text=cmd.roll.total+(p.dc!=null?' · '+(cmd.roll.total>=p.dc?'Éxito':'Fallo'):'');event.secret=p.secret;s.pending=s.pending.filter(x=>x.id!==p.id);break;}
      case 'declare': {
        requireRule(cmd.text?.trim(),'Describir la acción');
        if(s.phase==='combate')requireRule(s.activeId===a.id,'Solo puede proponer acciones ordinarias en su turno.');
        s.pending.push({id:cmd.id,kind:'assisted',actorId:a.id,ownerUid:a.ownerUid,label:cmd.label||'Acción propuesta',text:cmd.text,cost:cmd.cost||'action',targets:cmd.targets||[],spell:cmd.spell||null,resource:cmd.resource||null});event.text='Propuesta pendiente del GM: '+cmd.text;break;
      }
      case 'action': consume(a,s,cmd.cost||'action');if(cmd.kind==='dash')a.economy.movement-=a.speed;if(cmd.kind==='dodge')a.conditions=[...new Set([...a.conditions,'Esquivando'])];if(cmd.kind==='disengage')a.conditions=[...new Set([...a.conditions,'Desenganchado'])];event.text=cmd.label;break;
      case 'move':consume(a,s,'movement');requireRule(n(cmd.distance)>0&&a.economy.movement+n(cmd.distance)<=a.speed,'Supera el movimiento disponible.');a.economy.movement+=n(cmd.distance);event.text='Se desplaza '+cmd.distance+' pies · posición confirmada por la mesa';break;
      case 'attack':{
        const target=get(cmd.targetId);consume(a,s,'attack');requireRule(cmd.roll,'Falta ataque');
        const hit=cmd.roll.natural===20||cmd.roll.natural!==1&&cmd.roll.total>=target.ac+(target.shield?5:0);
        event.text=hit?'Posible impacto · ventana de respuesta':'Falla';event.target=target.name;
        if(hit)s.pending.push({id:cmd.id,kind:'attack',actorId:a.id,targetId:target.id,label:cmd.label,roll:cmd.roll,damageRoll:cmd.damageRoll,damageType:cmd.damageType||'sin tipo',critical:cmd.roll.natural===20,blocked:[],costCommitted:true});break;
      }
      case 'spell':{
        const level=n(cmd.level);const base=n(cmd.baseLevel);requireRule(level>=base&&level<=9,'Nivel de espacio inválido.');
        consume(a,s,cmd.cost||'action',cmd.cost==='bonus'?'bonusSpell':level?'leveledSpell':null);slot(a,level);
        requireRule((cmd.targets||[]).length,'Elegir objetivo(s), incluido el lanzador si corresponde.');for(const id of cmd.targets)get(id);
        if(cmd.concentration){a.concentration={name:cmd.label,actionId:cmd.id};a.concentrationCheck=null;}
        if(cmd.magicMissile){requireRule(level>=1,'Proyectil Mágico requiere espacio.');requireRule(cmd.targets.length===2+level,'Repartir todos los proyectiles.');requireRule(cmd.roll&&cmd.roll.total>=2&&cmd.roll.total<=5,'Daño de proyectil inválido.');}
        s.pending.push({id:cmd.id,kind:cmd.magicMissile?'missile':cmd.healing?'heal':cmd.save?'area':cmd.attack?'spellAttack':'spell',actorId:a.id,targets:cmd.targets,label:cmd.label,roll:cmd.roll,damageRoll:cmd.damageRoll||cmd.roll,damageType:cmd.damageType||'sin tipo',dc:n(cmd.dc),attribute:cmd.attribute,half:!!cmd.half,concentration:!!cmd.concentration,blocked:[],responses:{},costCommitted:true,description:cmd.description||''});
        event.text='Conjuro lanzado · se abrió la ventana de respuesta';break;
      }
      case 'reaction':{
        const p=s.pending.find(p=>p.id===cmd.pendingId);requireRule(p,'La acción ya se resolvió.');
        if(cmd.kind==='shield'){
          requireRule(p.targetId===a.id||(p.targets||[]).includes(a.id),'No es objetivo de esta acción.');
          requireRule(['attack','spellAttack','missile'].includes(p.kind),'Escudo no responde a esta acción.');
          requireRule(s.phase!=='combate'||s.activeId!==a.id||!a.economy.bonusSpell,'Tras un conjuro como acción adicional no puede lanzar Escudo en ese mismo turno.');
          requireRule((a.dnd.conjuros||[]).some(c=>c.nombre==='Escudo'),'Escudo no figura en sus conjuros.');consume(a,s,'reaction');slot(a,n(cmd.level,1));a.shield=true;p.blocked=[...new Set([...p.blocked,a.id])];event.text='Escudo · +5 CA hasta su siguiente turno; bloquea Proyectil Mágico';
        }else {consume(a,s,'reaction');event.text=cmd.text||'Reacción registrada; el GM resuelve su efecto';}
        break;
      }
      case 'resolve':{
        const p=s.pending.find(p=>p.id===cmd.pendingId);requireRule(p,'La resolución ya no está pendiente.');a=get(p.actorId);event.actor=a.name;event.actorId=a.id;event.label=p.label;event.roll=p.damageRoll||p.roll;event.actionId=p.id;
        if(p.kind==='assisted'){
          consume(a,s,p.cost,p.spell?(p.cost==='bonus'?'bonusSpell':p.spell.level?'leveledSpell':null):null);
          if(p.spell){slot(a,p.spell.level);if(p.spell.concentration)a.concentration={name:p.label,actionId:p.id};}
          if(p.resource){const r=(a.resources||[]).find(r=>r.clave===p.resource);requireRule(r&&n(r.usados)<n(r.maximo),'No quedan usos de ese recurso.');r.usados=n(r.usados)+1;a.dnd.recursosClaseUsados=a.dnd.recursosClaseUsados||{};a.dnd.recursosClaseUsados[r.clave]=r.usados;}
          event.text=cmd.reason||p.text;
          if(cmd.targetId&&n(cmd.delta)!==0){const t=get(cmd.targetId);event.changes.push(cmd.delta<0?damage(t,-cmd.delta,cmd.damageType):heal(t,cmd.delta));}
          if(cmd.condition&&cmd.targetId){const t=get(cmd.targetId);t.conditions=[...new Set([...t.conditions,cmd.condition])];}
        }
        else if(p.kind==='attack'||p.kind==='spellAttack'){
          const t=get(p.targetId||(p.targets||[])[0]);const r=p.roll;const hit=r.natural===20||r.natural!==1&&r.total>=t.ac+(t.shield?5:0);
          if(hit){requireRule(p.damageRoll,'Falta el daño de la acción');event.changes.push(damage(t,p.damageRoll.total,p.damageType,p.critical));event.text='Impacta';}else event.text='Escudo evita el impacto';
        }else if(p.kind==='missile'){
          const counts={};for(const id of p.targets)counts[id]=(counts[id]||0)+1;
          for(const [id,count] of Object.entries(counts)){const t=get(id);if(t.shield){event.text+='Escudo protege a '+t.name+'. ';continue;}event.changes.push(damage(t,p.roll.total*count,'fuerza'));}
          event.text+=p.targets.length+' proyectiles · daño compartido '+p.roll.total+' por proyectil';
        }else if(p.kind==='heal'){for(const id of p.targets)event.changes.push(heal(get(id),p.damageRoll.total));event.text='Curación confirmada';}
        else if(p.kind==='area'){
          for(const id of p.targets){requireRule(p.responses[id],'Falta una salvación del área');const t=get(id);const success=p.responses[id].total>=p.dc;const amount=success?(p.half?Math.floor(p.damageRoll.total/2):0):p.damageRoll.total;event.changes.push(damage(t,amount,p.damageType));}event.text='Salvaciones y daño del área confirmados';
        }else event.text=cmd.reason||p.description||'Efecto confirmado por el GM';
        s.pending=s.pending.filter(x=>x.id!==p.id);break;
      }
      case 'save':{
        const p=s.pending.find(p=>p.id===cmd.pendingId&&p.kind==='area');requireRule(p&&p.targets.includes(a.id),'No corresponde esta salvación');requireRule(!p.responses[a.id],'Ya respondió esta salvación');p.responses[a.id]=cmd.roll;event.text='Salvación '+cmd.roll.total;break;
      }
      case 'cancel':{const p=s.pending.find(p=>p.id===cmd.pendingId);requireRule(p,'No existe ese pendiente');s.pending=s.pending.filter(p=>p.id!==cmd.pendingId);event.text='Cancelada con motivo: '+(cmd.reason||'decisión del GM')+(p.costCommitted?' · recursos gastados conservados':'');break;}
      case 'concentration':requireRule(a.concentrationCheck,'No hay salvación de concentración pendiente');event.text=cmd.roll.total>=a.concentrationCheck.dc?'Mantiene concentración':'Pierde concentración';if(cmd.roll.total<a.concentrationCheck.dc)a.concentration=null;a.concentrationCheck=null;break;
      case 'death':requireRule(s.phase!=='combate'||s.activeId===a.id,'La salvación de muerte corresponde al inicio de su turno.');event.text=deathSave(a,cmd.roll);break;
      case 'shortRest':{
        a=get(cmd.actorId);const available=Math.max(0,n((a.dnd.dadosGolpeTotal||a.level+'d8').split('d')[0])-n(a.dnd.dadosGolpeGastados));requireRule(n(cmd.diceCount)>=0&&n(cmd.diceCount)<=available,'Dados de golpe insuficientes');const groups=cmd.roll?.groups?.filter(g=>g.values)||[];requireRule(groups.reduce((t,g)=>t+g.values.length,0)===n(cmd.diceCount),'Cantidad de dados incorrecta');
        const amount=groups.flatMap(g=>g.values).reduce((t,v)=>t+Math.max(0,v+mod(a.stats.con)),0);event.changes.push(heal(a,amount));a.dnd.dadosGolpeGastados=n(a.dnd.dadosGolpeGastados)+n(cmd.diceCount);if(a.classId==='brujo')Object.values(a.slots).forEach(e=>e.gastados=0);for(const r of a.resources||[])if(['corto','ambos'].includes(r.recarga)){r.usados=0;if(a.dnd.recursosClaseUsados)a.dnd.recursosClaseUsados[r.clave]=0;}event.text='Descanso corto de al menos 1 hora confirmado';break;
      }
      case 'longRest':a=get(cmd.actorId);requireRule(a.hp>0,'Descanso largo requiere al menos 1 PV al comenzar.');requireRule(a.lastLongRest==null||n(cmd.fictionHour)-a.lastLongRest>=24,'Solo un descanso largo por 24 horas ficticias.');a.shield=false;a.reckless=false;a.conditions=a.conditions.filter(c=>!['Esquivando','Desenganchado'].includes(c));a.economy={action:false,bonus:false,reaction:false,movement:0,attacks:0,bonusSpell:false,leveledSpell:false};a.lastLongRest=n(cmd.fictionHour);event.changes.push(heal(a,a.max));a.dnd.dadosGolpeGastados=Math.max(0,n(a.dnd.dadosGolpeGastados)-Math.max(1,Math.floor(a.level/2)));Object.values(a.slots).forEach(e=>e.gastados=0);for(const r of a.resources||[]){r.usados=0;if(a.dnd.recursosClaseUsados)a.dnd.recursosClaseUsados[r.clave]=0;}event.text='Descanso largo de al menos 8 horas confirmado';break;
      case 'xp':a=get(cmd.actorId);a.xp=n(a.xp)+Math.max(0,n(cmd.amount));event.text=a.name+' recibe '+cmd.amount+' PX';break;
      case 'close':requireRule(!s.pending.length,'Cerrar pendientes primero.');s.closed=true;s.phase='cerrada';event.text='Sesión cerrada';break;
      case 'reopen':requireRule(cmd.newSessionId,'Reabrir requiere una identidad de sesión nueva.');s.sessionId=cmd.newSessionId;s.closed=false;s.phase='exploracion';s.activeId=null;event.text='Mesa reabierta como una nueva sesión';break;
      default: throw new Error('Comando no reconocido: '+cmd.type);
    }
    for(const change of event.changes)change.actorName=s.actors.find(a=>a.id===change.actorId)?.name||'';
    s.revision++;event.revision=s.revision;s.lastEvents=[...s.lastEvents,event].slice(-100);
    return {state:clone(s),event:clone(event)};
  }
  function publicState(s){const p=clone(s);delete p.restoreArchive;for(const a of p.actors){for(const k of ['dnd','stats','slots','classId','resistances','immunities','vulnerabilities','monster','monsterId','resources','saves'])delete a[k];}p.pending=p.pending.filter(x=>!x.secret);p.lastEvents=p.lastEvents.filter(e=>!e.secret);return p;}
  return {n,mod,clone,parse,roll,d20,validateRoll,actor,state,reduce,publicState,damage,heal,deathSave};
});
