const express=require("express");
const http=require("http");
const twilio=require("twilio");
const WebSocket=require("ws");
const {WebSocketServer}=require("ws");
const {twiml:{VoiceResponse}}=twilio;

const app=express();
app.use(express.urlencoded({extended:false}));
app.use(express.json());

const PORT=process.env.PORT||3000;
const OPENAI_API_KEY=process.env.OPENAI_API_KEY||"";
const REALTIME_MODEL=process.env.REALTIME_MODEL||"gpt-realtime-2.1";
const REALTIME_VOICE=process.env.REALTIME_VOICE||"marin";
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||"").trim();
const BLACKLEAF_API_KEY=process.env.BLACKLEAF_API_KEY||"";
const BLACKLEAF_MENU_TEMPLATE_ID=process.env.BLACKLEAF_MENU_TEMPLATE_ID||"";
const BLACKLEAF_SENDER_PROFILE_ID=process.env.BLACKLEAF_SENDER_PROFILE_ID||"";
const BLACKLEAF_SMS_URL="https://api.blackleaf.io/messaging/send/text";

const MENU_URL="https://www.thefarmersdaughtersdispensary.com/menu";
const WEBSITE_URL="https://www.thefarmersdaughtersdispensary.com";
const STORE_ADDRESS="1025 Chetco Ave, Brookings, Oregon 97415";
const STORE_PHONE="541-813-1711";
const VENDOR_EMAIL="brookingsvendors@gmail.com";
const FALLBACK_VOICE="Polly.Danielle-Neural";

function phone(v){if(!v)return null;const r=String(v).trim();if(/^(client|sip):/i.test(r))return null;const d=r.replace(/\D/g,"");if(d.length===10)return`+1${d}`;if(d.length===11&&d[0]==="1")return`+${d}`;if(d.length>=8&&d.length<=15)return`+${d}`;return null;}
function parse(v){try{return v?JSON.parse(v):{}}catch{return{}}}
function open(ws){return ws&&ws.readyState===WebSocket.OPEN}
function now(){const f=new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",weekday:"long",hour:"numeric",minute:"numeric",hourCycle:"h23"});const p=Object.fromEntries(f.formatToParts(new Date()).map(x=>[x.type,x.value]));return{day:(p.weekday||"").toLowerCase(),mins:Number(p.hour)*60+Number(p.minute)}}
function status(){const m=now().mins;if(m<540)return"We're closed right now and open at 9 AM today.";if(m>=1260)return"We're closed for the night and open again at 9 AM tomorrow.";if(m>=1230)return"We're open until 9 PM tonight, so we're closing soon.";return"We're open right now until 9 PM."}
function deal(){return({monday:"Today's deal is four times loyalty points.",tuesday:"Today's deal is 20 percent off infused joints and joint packs.",wednesday:"Today's deal is 20 percent off cartridges.",thursday:"Today's deal is 20 percent off edibles.",friday:"Today's deal is 20 percent off flower in jars.",saturday:"Today's deal is 20 percent off dabs, extracts, and rosin.",sunday:"Today's deal is 50 percent off ounces in jars."})[now().day]||"You can check today's deal on our website."}
function wsUrl(req){if(PUBLIC_BASE_URL)return PUBLIC_BASE_URL.replace(/^https:/i,"wss:").replace(/^http:/i,"ws:").replace(/\/$/,"")+"/media-stream";return`wss://${req.headers["x-forwarded-host"]||req.headers.host}/media-stream`}

async function textLink(to){
  const toPhone=phone(to);
  if(!toPhone)throw new Error("Invalid caller phone number");
  if(!BLACKLEAF_API_KEY)throw new Error("Missing BLACKLEAF_API_KEY");
  if(!BLACKLEAF_MENU_TEMPLATE_ID)throw new Error("Missing BLACKLEAF_MENU_TEMPLATE_ID");
  if(!BLACKLEAF_SENDER_PROFILE_ID)throw new Error("Missing BLACKLEAF_SENDER_PROFILE_ID");
  const c=new AbortController(),t=setTimeout(()=>c.abort(),7000);let r;
  try{r=await fetch(BLACKLEAF_SMS_URL,{method:"POST",headers:{Authorization:`Bearer ${BLACKLEAF_API_KEY}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({to:toPhone,templateId:BLACKLEAF_MENU_TEMPLATE_ID,landingUrl:MENU_URL,sendingProfileId:BLACKLEAF_SENDER_PROFILE_ID}),signal:c.signal})}finally{clearTimeout(t)}
  const raw=await r.text();let data;try{data=raw?JSON.parse(raw):{}}catch{data={raw}}
  if(!r.ok||data?.success===false||data?.accepted===false||String(data?.status||"").toLowerCase()==="rejected"){console.error("Blackleaf rejected:",JSON.stringify(data,null,2));throw new Error(`Blackleaf send failed (${r.status})`)}
  console.log("Blackleaf accepted:",JSON.stringify(data,null,2));return data;
}

const INSTRUCTIONS=`You are Jasmine, the phone assistant for The Farmers Daughters Dispensary in Brookings, Oregon.
Speak naturally like a knowledgeable budtender. Be warm, relaxed, confident, and concise. Most answers should be one or two short sentences. Let callers interrupt. Do not say you are an AI unless directly asked; if asked, say you are the shop's automated phone assistant. Never invent facts, prices, policies, deals, or inventory.
Store facts:
- Address: ${STORE_ADDRESS}. Right off Highway 101 behind Dragon Palace and Rancho Viejo, set back by the tall dispensary sign.
- Hours: 9 AM to 9 PM every day.
- Payment: cash and debit.
- Age: 21+ with valid ID.
- Website: ${WEBSITE_URL}
- Menu and online ordering: ${MENU_URL}
- Phone: ${STORE_PHONE}
- First visit 5% off, second 10%, third 15%, fourth 20%.
- Happy hour daily 4:20-6:20 PM: 20% off Cookies, Khalifa Kush, Tyson, Select, and Hotbox.
- Monday 4x loyalty points; Tuesday 20% off infused joints/joint packs; Wednesday 20% off cartridges; Thursday 20% off edibles; Friday 20% off flower in jars; Saturday 20% off dabs/extracts/rosin; Sunday 50% off ounces in jars.
- Vendors: ${VENDOR_EMAIL}. Showing and samples Monday-Friday.
Rules:
- Use get_store_status for current open/closed status and get_todays_deal for today's deal.
- Live inventory is not connected. Never guess stock. Use check_live_inventory and offer to text the live menu.
- If asked to text the menu/order link, call send_menu_text immediately. Never claim success unless the tool returns success=true.
- If asked how to order, say orders go through the online menu and offer to text it.
- If asked to text today's deals, call send_deals_text.
- Never take an order over the phone.
- For an unknown store-specific question, use record_unknown_question and say you do not want to give wrong information.
- After tools, answer naturally without mentioning APIs, templates, or Blackleaf.`;

const TOOLS=[
 {type:"function",name:"get_store_status",description:"Get current store open/closed status.",parameters:{type:"object",properties:{},additionalProperties:false}},
 {type:"function",name:"get_todays_deal",description:"Get today's daily deal.",parameters:{type:"object",properties:{},additionalProperties:false}},
 {type:"function",name:"check_live_inventory",description:"Check live inventory connection. Never guess stock.",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false}},
 {type:"function",name:"send_menu_text",description:"Text the requested information/menu link to the current caller.",parameters:{type:"object",properties:{},additionalProperties:false}},
 {type:"function",name:"send_deals_text",description:"Text the requested information link after discussing today's deal.",parameters:{type:"object",properties:{},additionalProperties:false}},
 {type:"function",name:"record_unknown_question",description:"Log an unknown store-specific question for owner review.",parameters:{type:"object",properties:{question:{type:"string"}},required:["question"],additionalProperties:false}}
];

async function tool(name,args,ctx){
  if(name==="get_store_status")return{success:true,message:status()};
  if(name==="get_todays_deal")return{success:true,message:deal()};
  if(name==="check_live_inventory")return{success:false,liveDataChecked:false,message:"Live inventory is not connected yet. Do not claim stock. Offer to text the live online menu."};
  if(name==="send_menu_text"||name==="send_deals_text"){
    if(!ctx.callerNumber)return{success:false,message:"Caller phone number is unavailable. Do not claim a text was sent."};
    try{return{success:true,message:"The requested information link was accepted for sending.",provider:await textLink(ctx.callerNumber)}}catch(e){console.error("SMS error:",e.message||e);return{success:false,message:"The text failed. Do not claim it was sent. Give the website address instead."}}
  }
  if(name==="record_unknown_question"){console.log("JASMINE_UNKNOWN_QUESTION",JSON.stringify({time:new Date().toISOString(),callSid:ctx.callSid||null,caller:ctx.callerNumber||null,question:String(args?.question||"").trim()}));return{success:true,message:"Question logged for owner review."}}
  return{success:false,message:`Unknown tool: ${name}`};
}

app.get("/",(req,res)=>res.send("Jasmine realtime phone server is running."));
app.get("/health",(req,res)=>res.json({ok:true,model:REALTIME_MODEL,voice:REALTIME_VOICE,openai:Boolean(OPENAI_API_KEY),blackleaf:Boolean(BLACKLEAF_API_KEY),template:Boolean(BLACKLEAF_MENU_TEMPLATE_ID),sender:Boolean(BLACKLEAF_SENDER_PROFILE_ID),liveInventory:false}));
app.post("/voice",(req,res)=>{const callSid=req.body.CallSid||"unknown",caller=req.body.From||req.body.Caller||req.body.CallerNumber||"unknown";console.log("Incoming call:",callSid,caller);const vr=new VoiceResponse();if(!OPENAI_API_KEY){vr.say({voice:FALLBACK_VOICE},"Sorry, Jasmine is temporarily unavailable. Please visit thefarmersdaughtersdispensary.com.");vr.hangup();res.type("text/xml");return res.send(vr.toString())}const s=vr.connect().stream({url:wsUrl(req)});s.parameter({name:"callSid",value:String(callSid)});s.parameter({name:"callerNumber",value:String(caller)});vr.say({voice:FALLBACK_VOICE},"Sorry, Jasmine lost the connection. The live menu is at thefarmersdaughtersdispensary.com slash menu.");res.type("text/xml");res.send(vr.toString())});

const server=http.createServer(app),wss=new WebSocketServer({noServer:true});
server.on("upgrade",(req,socket,head)=>{let p="";try{p=new URL(req.url,"http://localhost").pathname}catch{socket.destroy();return}if(p!=="/media-stream"){socket.destroy();return}wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req))});

wss.on("connection",tw=>{
  console.log("Twilio Media Stream connected.");
  let sid=null,callSid=null,caller=null,lastTs=0,startTs=null,itemId=null,mark=null,markN=0,oa=null,ready=false,greeted=false,stopped=false,pending=[];
  const done=new Set(),ctx={get callSid(){return callSid},get callerNumber(){return phone(caller)}};
  const toTw=o=>{if(open(tw))tw.send(JSON.stringify(o))},toOA=o=>{if(!open(oa))return false;oa.send(JSON.stringify(o));return true};
  const reset=()=>{startTs=null;itemId=null;mark=null};
  const clear=()=>{if(!sid)return;toTw({event:"clear",streamSid:sid});if(itemId&&startTs!==null)toOA({type:"conversation.item.truncate",item_id:itemId,content_index:0,audio_end_ms:Math.max(0,Math.floor(lastTs-startTs))});reset()};
  const markDone=()=>{if(!sid||!itemId)return;mark=`jasmine-${++markN}`;toTw({event:"mark",streamSid:sid,mark:{name:mark}})};
  const flush=()=>{if(!ready)return;for(const a of pending)toOA({type:"input_audio_buffer.append",audio:a});pending=[]};
  const greet=()=>{if(!ready||greeted)return;greeted=true;toOA({type:"response.create",response:{input:[],instructions:"Say exactly: Thanks for calling The Farmers Daughters Dispensary. This is Jasmine. How can I help?"}})};
  async function callTool(e){if(!e.call_id||done.has(e.call_id))return;done.add(e.call_id);const args=parse(e.arguments);console.log("Jasmine tool call:",e.name,JSON.stringify(args));let r;try{r=await tool(e.name,args,ctx)}catch(err){console.error("Tool error:",err.message||err);r={success:false,message:"The requested action failed. Do not claim it succeeded."}}console.log("Jasmine tool result:",e.name,JSON.stringify(r));toOA({type:"conversation.item.create",item:{type:"function_call_output",call_id:e.call_id,output:JSON.stringify(r)}});toOA({type:"response.create"})}
  function connect(){if(oa||stopped)return;oa=new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,{headers:{Authorization:`Bearer ${OPENAI_API_KEY}`}});oa.on("open",()=>{console.log("Connected to OpenAI Realtime:",REALTIME_MODEL);toOA({type:"session.update",session:{type:"realtime",output_modalities:["audio"],audio:{input:{format:{type:"audio/pcmu"},turn_detection:{type:"semantic_vad",eagerness:"high",create_response:true,interrupt_response:true}},output:{format:{type:"audio/pcmu"},voice:REALTIME_VOICE}},instructions:INSTRUCTIONS,tools:TOOLS,tool_choice:"auto",max_output_tokens:300}})});oa.on("message",async raw=>{let e;try{e=JSON.parse(raw.toString())}catch{return}if(e.type==="session.updated"){if(!ready){ready=true;console.log(`Jasmine ready. Voice=${REALTIME_VOICE}, Model=${REALTIME_MODEL}`);greet();flush()}return}if(e.type==="response.output_item.added"&&e.item?.type==="message"){itemId=e.item.id||itemId;startTs=null;mark=null;return}if(e.type==="response.output_audio.delta"&&e.delta&&sid){if(e.item_id)itemId=e.item_id;if(startTs===null)startTs=lastTs;toTw({event:"media",streamSid:sid,media:{payload:e.delta}});return}if(e.type==="response.output_audio.done"){markDone();return}if(e.type==="input_audio_buffer.speech_started"){if(itemId){console.log("Caller interrupted Jasmine.");clear()}return}if(e.type==="response.function_call_arguments.done"){await callTool(e);return}if(e.type==="error")console.error("OpenAI Realtime error:",JSON.stringify(e))});oa.on("error",e=>console.error("OpenAI WebSocket error:",e.message||e));oa.on("close",(c,r)=>{ready=false;console.log("OpenAI WebSocket closed:",c,r?.toString?.()||"");if(!stopped&&open(tw))tw.close()})}
  tw.on("message",raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}if(m.event==="start"){sid=m.start?.streamSid||m.streamSid||null;callSid=m.start?.customParameters?.callSid||m.start?.callSid||null;caller=m.start?.customParameters?.callerNumber||null;console.log("Twilio stream started:",JSON.stringify({sid,callSid,caller,format:m.start?.mediaFormat||{}}));connect();return}if(m.event==="media"){const a=m.media?.payload,t=Number(m.media?.timestamp);if(Number.isFinite(t))lastTs=t;if(!a)return;if(ready&&open(oa))toOA({type:"input_audio_buffer.append",audio:a});else{pending.push(a);if(pending.length>500)pending=pending.slice(-500)}return}if(m.event==="mark"&&mark&&m.mark?.name===mark){reset();return}if(m.event==="stop"){stopped=true;console.log("Twilio media stream stopped.");if(open(oa))oa.close()}});
  tw.on("error",e=>console.error("Twilio WebSocket error:",e.message||e));
  tw.on("close",()=>{stopped=true;console.log("Twilio Media Stream closed.");if(open(oa))oa.close()});
});

server.listen(PORT,"0.0.0.0",()=>{console.log(`Jasmine server running on port ${PORT}`);console.log(`Realtime model: ${REALTIME_MODEL}`);console.log(`Realtime voice: ${REALTIME_VOICE}`);console.log(`OpenAI configured: ${Boolean(OPENAI_API_KEY)}`);console.log(`Blackleaf API configured: ${Boolean(BLACKLEAF_API_KEY)}`);console.log(`Blackleaf template configured: ${Boolean(BLACKLEAF_MENU_TEMPLATE_ID)}`);console.log(`Blackleaf sender configured: ${Boolean(BLACKLEAF_SENDER_PROFILE_ID)}`)});
