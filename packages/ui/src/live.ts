import { html, raw, type Html } from './html.js';

/**
 * Live pages: the only script besides the theme toggle.
 *
 * ## What it does
 *
 * A page that can change while it is open (a run being checked, the workspace dashboard)
 * marks one element `data-live="<url>"` with `data-live-token="<fingerprint>"`. This script
 * asks that URL (a small JSON read) every few seconds. When the fingerprint the server
 * returns differs from the one on the page, it fetches the page again and swaps in the new
 * `<main>`, so what the reader sees is always the server's own rendering: there is no second
 * template in here to drift from the first.
 *
 * Between changes it counts down to the next planned check and the deadline when the page
 * gives them (`data-next-check`, `data-deadline`, `data-checks`), read from the run row and
 * never guessed. It polls quickly while something is in flight (`active` in the reply) and
 * slowly otherwise, pauses while the tab is hidden, stops after thirty minutes, and stops on
 * 401/404. Everything it writes itself goes through `textContent`; the only markup it
 * inserts is the page the server rendered.
 *
 * ## Why it is a constant
 *
 * The CSP allows scripts by hash only. `buildCsp()` hashes this exact string, so it must be
 * rendered byte for byte, with nothing between the tags but this text.
 */
export const LIVE_SCRIPT: string = `(function(){
var started=Date.now(),timer=null,busy=false;
function root(){return document.querySelector('[data-live]');}
function say(t){var r=root();var o=r&&r.querySelector('[data-live-status]');if(o){o.textContent=t;}}
function span(ms){if(!(ms>0)){return 'now';}var s=Math.ceil(ms/1000);return s>=60?Math.floor(s/60)+'m '+(s%60)+'s':s+'s';}
function count(){var r=root();if(!r){return;}if(r.getAttribute('data-live-active')!=='1'){say('Live. Nothing is being checked right now; new results appear here as they arrive.');return;}
var n=Date.parse(r.getAttribute('data-next-check')||''),d=Date.parse(r.getAttribute('data-deadline')||''),now=Date.now(),parts=[];
if(!isNaN(n)){parts.push(n<=now?'checking your providers now':'next check in '+span(n-now));}
if(!isNaN(d)){parts.push(d<=now?'deadline reached, deciding':'deadline in '+span(d-now));}
var c=r.getAttribute('data-checks');if(c!==null&&c!==''){parts.push('checked '+c+(c==='1'?' time':' times'));}
say(parts.length?'Live: '+parts.join(' \\u00b7 ')+'.':'Live: still checking; this updates by itself.');}
function editing(){var a=document.activeElement;if(a&&a.closest&&a.closest('main form')&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){return true;}var f=document.querySelectorAll('main form input:not([type=hidden]),main form textarea');for(var i=0;i<f.length;i++){if(f[i].value!==f[i].defaultValue){return true;}}return false;}
function stop(t){if(timer){clearTimeout(timer);}timer=null;if(t){say(t);}}
function later(ms){if(timer){clearTimeout(timer);}timer=setTimeout(poll,ms);}
function swap(){return fetch(location.pathname+location.search,{credentials:'same-origin',cache:'no-store'}).then(function(res){if(!res.ok){throw new Error('status');}return res.text();}).then(function(text){var doc=new DOMParser().parseFromString(text,'text/html');var fresh=doc.querySelector('main'),cur=document.querySelector('main');if(fresh&&cur){cur.replaceWith(document.importNode(fresh,true));document.title=doc.title;}});}
function poll(){var r=root();if(!r){stop();return;}
if(document.hidden){later(5000);return;}
if(Date.now()-started>1800000){stop('Live updates paused after 30 minutes. Reload to see the latest.');return;}
if(busy){return;}busy=true;
fetch(r.getAttribute('data-live'),{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'}}).then(function(res){if(res.status===401||res.status===404){throw new Error('gone');}if(!res.ok){throw new Error('status');}return res.json();}).then(function(p){
r.setAttribute('data-live-active',p.active?'1':'0');r.setAttribute('data-next-check',p.nextCheckAt||'');if(p.checks!==undefined){r.setAttribute('data-checks',String(p.checks));}
if(String(p.token)!==r.getAttribute('data-live-token')&&editing()){say('New results are in. They will appear once you have finished with the form.');later(5000);return;}
if(String(p.token)!==r.getAttribute('data-live-token')){return swap().then(function(){var n=root();if(n&&n.hasAttribute('data-status')&&n.getAttribute('data-status')!=='PENDING'){stop();return;}count();later(p.active?3000:20000);});}
count();later(p.active?3000:20000);}).catch(function(e){if(e&&e.message==='gone'){stop('Live updates stopped: sign in again to see this.');}else{say('Live updates are having trouble reaching us; trying again.');later(10000);}}).then(function(){busy=false;});}
if(!root()){return;}
count();setInterval(count,1000);later(2000);
document.addEventListener('visibilitychange',function(){if(!document.hidden&&root()){poll();}});
})();`;

/**
 * The script element, exactly as `buildCsp()` hashes it: nothing but the constant between
 * the tags. Rendered once per live page, inside `<main>`, so a swapped-in page carries a
 * copy that the browser does not run again (the running one keeps working).
 */
export function LiveScript(): Html {
  return html`<script>${raw(LIVE_SCRIPT)}</script>`;
}
