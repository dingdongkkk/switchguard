/** Shared visual shell. Static markup only; session data is rendered using textContent. */
const paths: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  wave: '<path d="M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4"/>',
  flask: '<path d="M9 3h6m-5 0v6L4 19a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2L14 9V3M7 15h10"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  book: '<path d="M12 5v16M3 3l9 2 9-2v16l-9 2-9-2z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  flag: '<path d="M5 21V4c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
export function icon(name: string, className = ''): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor');
  svg.setAttribute('stroke-width','1.6'); svg.setAttribute('stroke-linecap','round'); svg.setAttribute('stroke-linejoin','round');
  svg.setAttribute('aria-hidden','true'); svg.setAttribute('class',`icon ${className}`);
  svg.innerHTML = paths[name] ?? paths.wave!;
  return svg;
}
const candidate = location.pathname === '/candidate.html';
const page = candidate ? 'candidate' : location.pathname.includes('reviewer') ? 'reviewer' : location.pathname.includes('sandbox') ? 'sandbox' : location.pathname.includes('report') ? 'report' : 'home';
document.body.dataset.page = page;
const brand = '<a class="brand" href="/" aria-label="SwitchGuard home"><span class="brand-mark"><i></i><i></i><i></i><i></i></span>SwitchGuard<span class="brand-period">.</span></a>';
const oldHeader = document.querySelector('header.top');
const header = document.createElement('header'); header.className = 'top no-print';
if (candidate) {
  header.innerHTML = brand + '<div class="candidate-header-meta"><span class="privacy-mark">Private interview</span></div>';
  const meta=header.querySelector('.candidate-header-meta')!;
  for(const id of ['who','monitoring']) { const item=document.getElementById(id); if(item)meta.append(item); }
} else {
  document.body.classList.add('workspace');
  const aside = document.createElement('aside'); aside.className='sidebar no-print';
  aside.innerHTML=brand+'<div class="workspace-switch"><span class="workspace-avatar">S</span><div>Interview workspace<small>Your review console</small></div><span class="workspace-chevron">⌄</span></div><span class="nav-caption">WORKSPACE</span><nav aria-label="Main navigation"></nav><button class="sidebar-create" type="button">New interview</button><div class="sidebar-bottom"><div class="human-note"><strong>Built for human judgment.</strong><p>Voice signals add context.<br>You make the decision.</p></div><div class="sidebar-account"><span class="avatar">R</span><div>Reviewer<small>Private workspace</small></div><button class="signout" type="button" title="Sign out" aria-label="Sign out">↗</button></div></div>';
  const nav=aside.querySelector('nav')!;
  for(const [name,label,url,selected] of [['grid','Overview','/',page==='home'],['wave','Interview sessions','/#sessions',page==='reviewer'],['flask','Testing sandbox','/sandbox.html',page==='sandbox']] as const){
    const link=document.createElement('a');link.href=url;link.className=selected?'nav-link active':'nav-link';if(selected)link.setAttribute('aria-current','page');link.append(icon(name),document.createTextNode(label));nav.append(link);
  }
  aside.querySelector('.sidebar-create')!.prepend(icon('plus'));
  aside.querySelector('.sidebar-create')!.addEventListener('click',()=>{if(page==='home')document.dispatchEvent(new Event('sg:new-interview'));else location.href='/#new';});
  aside.querySelector('.signout')!.addEventListener('click',()=>{sessionStorage.removeItem('sg.reviewerToken');sessionStorage.removeItem('sg.signIn');location.href='/';});
  document.body.prepend(aside);
  header.innerHTML='<div class="breadcrumbs"><span>Workspace</span><span class="breadcrumb-slash">/</span><strong></strong></div><div class="top-actions"><button class="guide-button" type="button">Review guide</button><span class="avatar small">R</span></div>';
  header.querySelector('.breadcrumbs strong')!.textContent={home:'Overview',reviewer:'Session review',sandbox:'Testing sandbox',report:'Evidence report',candidate:'Interview'}[page];
  header.querySelector('.guide-button')!.prepend(icon('book'));
  const print=document.getElementById('print');if(print)header.querySelector('.top-actions')!.prepend(print);
}
if(oldHeader)oldHeader.replaceWith(header);else document.body.prepend(header);
const skip=document.createElement('a');skip.href='#main-content';skip.className='skip-link';skip.textContent='Skip to content';document.body.prepend(skip);
const main=document.querySelector('main');if(main){if(!main.id)main.id='main-content';else skip.href=`#${main.id}`;main.tabIndex=-1;skip.addEventListener('click',event=>{event.preventDefault();main.focus({preventScroll:true});main.scrollIntoView({behavior:'auto'});});}
const guide=document.createElement('dialog');guide.className='guide-dialog';guide.setAttribute('aria-labelledby','guide-title');
guide.innerHTML='<form method="dialog"><button class="dialog-close" aria-label="Close guide">×</button></form><span class="eyebrow">THE SWITCHGUARD APPROACH</span><h2 id="guide-title">More context.<br>Better judgment.</h2><p class="lead">Follow the evidence, then make your own assessment.</p><ol class="guide-steps"><li><strong>Establish a reference</strong><p>The candidate consents and records a voice sample. Voice continuity is not proof of real-world identity.</p></li><li><strong>Keep the signals separate</strong><p>Speaker similarity and voice authenticity answer different questions. A failed or missing check is never a pass.</p></li><li><strong>Review in context</strong><p>Listen to flagged answers, inspect surrounding audio and request fresh verification when needed.</p></li><li><strong>Record your decision</strong><p>Keep notes and resolutions alongside the original evidence. Nothing is rejected automatically.</p></li></ol>';
document.body.append(guide);header.querySelector('.guide-button')?.addEventListener('click',()=>guide.showModal());
guide.addEventListener('click',e=>{if(e.target===guide)guide.close();});
