/**
 * The stylesheet of an organization's public page on wizards.page: the portal draws the page with
 * it, the studio its preview of the page (studio/shared). Every colour and face comes from the
 * custom properties `lookOf` sets on the page's root.
 */
export const PAGE_STYLES = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--f-body);-webkit-font-smoothing:antialiased;line-height:1.4}
a{color:inherit}
h1,h2,h3{font-family:var(--f-display);margin:0;letter-spacing:-0.02em;font-weight:600}
p,ul,ol{margin:0}
ul,ol{padding:0;list-style:none}
.wp{max-width:1152px;margin:0 auto;padding:0 24px}
.band{background:var(--band);color:var(--on-band)}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px;padding-top:28px}
.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font-family:var(--f-display);font-weight:600;font-size:19px}
.brand img{height:36px;max-width:180px;object-fit:contain}
.mark{width:36px;height:36px;border-radius:9px;background:var(--on-band);color:var(--band);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-family:var(--f-body)}
.site{font-size:14px;opacity:.8;text-decoration:none}
.hero{padding-top:64px;padding-bottom:150px;display:flex;flex-direction:column;gap:18px}
.lbl{font-size:12px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;opacity:.72;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px}
.lbl b{font-weight:500;opacity:1}
.lbl i{width:3px;height:3px;border-radius:999px;background:currentColor;opacity:.6}
.hero h1{font-size:clamp(34px,4.6vw,56px);line-height:1.04;letter-spacing:-0.03em;max-width:820px}
.hero p{font-size:18px;max-width:36rem;opacity:.9}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;font-size:14px;opacity:.9}
.meta li{display:inline-flex;align-items:center;gap:6px}
.ico{width:16px;height:16px;flex:none}
.main{margin-top:-96px;padding-bottom:64px}
.card{background:var(--card);border-radius:16px;box-shadow:inset 0 0 0 1px var(--line),0 10px 24px -18px rgba(0,0,0,.35);position:relative}
.feat{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);box-shadow:inset 0 0 0 1px var(--line),0 30px 70px -36px rgba(0,0,0,.45)}
.feat-main{padding:32px 36px;display:flex;flex-direction:column;gap:18px;min-width:0}
.feat-side{background:var(--side);border-radius:0 16px 16px 0;padding:28px;display:flex;flex-direction:column;gap:14px;justify-content:center}
.perch{position:absolute;right:20px;top:-88px;z-index:2;pointer-events:none}
.peek{position:absolute;right:20px;top:-18px;pointer-events:none}
.lbl2{font-size:11.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.feat h2{font-size:clamp(26px,3vw,36px);line-height:1.08}
.lead{font-size:16px;line-height:1.5;color:var(--ink-2);max-width:34rem}
.does{display:flex;flex-direction:column;gap:6px;padding-top:4px;font-size:15px}
.does span{color:var(--muted)}
.stage{display:grid}
.act{grid-area:1/1;display:flex;flex-direction:column;gap:14px;min-width:0}
.steps{display:flex;flex-direction:column;gap:9px}
.steps li{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;animation:enter .6s cubic-bezier(.2,.7,.2,1) both calc(var(--i) * .5s)}
.tick{flex:none;width:18px;height:18px;border-radius:5px;border:1.5px solid var(--line);background:var(--card);display:inline-flex;align-items:center;justify-content:center;color:var(--accent)}
.tick svg{width:12px;height:12px;opacity:0;animation:tick .35s ease forwards calc(var(--i) * .5s + .35s)}
.steps-act{animation:out .5s ease forwards var(--t)}
.results-act{animation:rise .7s cubic-bezier(.2,.7,.2,1) both var(--t)}
@keyframes tick{to{opacity:1}}
@keyframes enter{from{opacity:0;transform:translateY(8px)}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@keyframes out{to{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion:reduce){.tick svg,.steps li,.results-act{animation:none;opacity:1}.steps-act{display:none}}
.prev{background:var(--card);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 10px 24px -16px rgba(0,0,0,.35);text-decoration:none;color:inherit}
.prev .res{font-size:13.5px}
.grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:4px}.grid i{display:block;height:6px;border-radius:2px;background:var(--line)}.grid i:nth-child(-n+3){height:7px;background:color-mix(in oklab,var(--accent) 30%,var(--line))}
.pl{display:flex;flex-direction:column;gap:5px}.pl i{display:block;height:5px;border-radius:3px;background:var(--line)}
.frame{height:56px;border-radius:8px;background:color-mix(in oklab,var(--accent) 12%,var(--ground));display:flex;align-items:center;justify-content:center;color:var(--accent)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.tiles i{display:block;height:22px;border-radius:4px;background:var(--line)}
.wave{display:flex;align-items:center;gap:3px;height:28px}.wave i{display:block;width:3px;border-radius:2px;background:color-mix(in oklab,var(--accent) 50%,var(--line))}
.ex{font-size:13px;color:var(--muted);text-decoration:none}.ex b{color:var(--ink);font-weight:600}
.cta{display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding-top:6px}
.cta small{font-size:13px;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:8px;height:48px;padding:0 24px;border-radius:999px;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:15px;text-decoration:none;white-space:nowrap}
.pill:hover{filter:brightness(.92)}
.res{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;line-height:1.35}
.kic{flex:none;width:20px;height:20px}
.files{font-size:12px;font-weight:500;color:var(--muted);letter-spacing:.02em}
.side-note{font-size:13px;color:var(--muted);line-height:1.5}
.sec{margin-top:80px}
.sec h2{font-family:var(--f-body);font-size:12px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.rows{margin-top:28px;display:flex;flex-direction:column;gap:28px}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end;padding:24px 28px}
.row-main{display:flex;flex-direction:column;gap:8px;min-width:0;padding-right:60px}
.row-title{font-size:13px;color:var(--muted)}
.row h3{font-size:26px;line-height:1.12}
.gets{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin-top:2px}
.gets span{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:600}
.row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-top:4px;font-size:13px;color:var(--ink-2)}
.row-meta li{display:inline-flex;align-items:center;gap:5px}
.row-desc{font-size:14.5px;line-height:1.45;color:var(--ink-2)}
.foot{padding-bottom:32px;font-size:12.5px;color:var(--muted)}
.foot-grid{display:grid;grid-template-columns:1fr 2fr 1fr;column-gap:40px;row-gap:28px;border-top:1px solid var(--line);padding-top:40px}
.foot h4{margin:0 0 12px;font-size:12px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.foot ul{display:flex;flex-direction:column;gap:6px}
.foot .two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 24px}
.foot a{color:var(--muted)}
.made{margin-top:40px;border-top:1px solid var(--line);padding-top:20px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px}
.made span{display:inline-flex;align-items:center;gap:8px}
.nothing{min-height:100vh;display:flex;flex-direction:column}
.nothing main{flex:1;display:flex;align-items:center;justify-content:center;padding:28px}
.nothing-box{max-width:420px;display:flex;flex-direction:column;gap:14px;align-items:flex-start}
.nothing h1{font-size:32px;line-height:1.1}
.nothing p{font-size:16px;line-height:1.55;color:var(--ink-2)}
@media (max-width:900px){.feat{grid-template-columns:1fr}.feat-side{border-radius:0 0 16px 16px}.row{grid-template-columns:1fr}.row .pill{justify-self:start}.foot-grid{grid-template-columns:1fr}.foot .two{grid-template-columns:1fr}}
@media (max-width:640px){.wp{padding-left:16px;padding-right:16px}.hero{padding-top:40px;padding-bottom:120px}.main{margin-top:-72px}.feat-main{padding:24px 20px}.feat-side{padding:24px 20px}.perch{right:10px;top:-62px}.perch svg{width:104px;height:104px}.row{padding:20px}.row-main{padding-right:48px}.row h3{font-size:22px}.sec{margin-top:56px}}
`;
