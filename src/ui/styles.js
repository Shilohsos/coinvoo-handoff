// The dashboard's one stylesheet, served from /dash/assets/ with a content hash in its name. Plain CSS: no
// framework, no preprocessor, no build step. Dark is the default theme; light is chosen on the page and remembered.
export const CSS = String.raw`
:root{
  color-scheme:dark;
  --bg:#0A0C10;--bg-2:#0D1015;--surface:#11141B;--surface-2:#161A23;--surface-3:#1C212C;
  --border:#212734;--border-2:#2B3242;--hairline:rgba(255,255,255,.04);
  --text:#E8EBF2;--text-2:#A3ABBC;--text-3:#6C7689;
  --accent:#7B8CFF;--accent-2:#A07BFF;--accent-ink:#0B0E1A;--accent-soft:rgba(123,140,255,.14);--accent-ring:rgba(123,140,255,.40);
  --pos:#34D399;--pos-soft:rgba(52,211,153,.13);--neg:#FB7185;--neg-soft:rgba(251,113,133,.13);
  --warn:#FBBF24;--warn-soft:rgba(251,191,36,.13);--info:#60A5FA;--info-soft:rgba(96,165,250,.13);
  --muted-soft:rgba(148,163,184,.12);
  --c-rev:#7B8CFF;--c-ftd:#34D399;--c-parked:#FBBF24;--c-expired:#5B6578;--grid:rgba(255,255,255,.06);
  --shadow-sm:0 1px 2px rgba(0,0,0,.35);
  --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 30px -10px rgba(0,0,0,.55);
  --shadow-lg:0 24px 70px -12px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.06);
  --r:12px;--r-sm:8px;--r-xs:6px;
  --side:248px;
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#F6F7F9;--bg-2:#FBFBFC;--surface:#FFFFFF;--surface-2:#F8F9FB;--surface-3:#F1F3F6;
  --border:#E5E8EE;--border-2:#D4D9E2;--hairline:rgba(15,23,40,.04);
  --text:#0F1728;--text-2:#4B5565;--text-3:#8792A4;
  --accent:#4F5FE8;--accent-2:#7C5CF0;--accent-ink:#FFFFFF;--accent-soft:rgba(79,95,232,.10);--accent-ring:rgba(79,95,232,.35);
  --pos:#059669;--pos-soft:rgba(5,150,105,.10);--neg:#E11D48;--neg-soft:rgba(225,29,72,.09);
  --warn:#C2730A;--warn-soft:rgba(217,119,6,.11);--info:#2563EB;--info-soft:rgba(37,99,235,.09);
  --muted-soft:rgba(100,116,139,.10);
  --c-rev:#5B6CF0;--c-ftd:#10B981;--c-parked:#F59E0B;--c-expired:#A0AABB;--grid:rgba(15,23,40,.07);
  --shadow-sm:0 1px 2px rgba(16,24,40,.05);
  --shadow:0 1px 2px rgba(16,24,40,.05),0 6px 20px -8px rgba(16,24,40,.12);
  --shadow-lg:0 24px 60px -12px rgba(16,24,40,.28),0 0 0 1px rgba(16,24,40,.06);
}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;font-feature-settings:"cv11","ss01"}
a{color:inherit;text-decoration:none}
a:hover{color:var(--accent)}
p{margin:0}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.01em}
img,svg{display:block}
svg{flex:none}
code,pre,kbd,.mono{font-family:var(--mono)}
.num,td.n,th.n{font-variant-numeric:tabular-nums}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
::selection{background:var(--accent-soft)}
.sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:12px;top:-60px;z-index:100;padding:8px 14px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-weight:600}
.skip:focus{top:12px;color:var(--accent-ink)}
.muted{color:var(--text-2)}
.faint{color:var(--text-3)}
.pos{color:var(--pos)}.neg{color:var(--neg)}.warn{color:var(--warn)}
.grow{flex:1}

/* ---------- app shell ---------- */
.app{position:relative;display:grid;grid-template-columns:var(--side) minmax(0,1fr);min-height:100vh}
.app::before{content:"";position:absolute;top:0;bottom:0;left:0;width:var(--side);background:var(--bg-2);border-right:1px solid var(--border);pointer-events:none}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:6px;padding:14px 12px;border-right:1px solid transparent;overflow-y:auto;z-index:30}
.brand{display:flex;align-items:center;gap:10px;padding:6px 8px 10px;font-weight:650;font-size:15px;letter-spacing:-.01em;color:var(--text)}
.brand:hover{color:var(--text)}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;box-shadow:0 4px 14px -4px var(--accent-ring),inset 0 1px 0 rgba(255,255,255,.25)}
.brand small{display:block;font-size:11px;font-weight:500;color:var(--text-3);letter-spacing:0}
.search-btn{display:flex;align-items:center;gap:8px;width:100%;margin:2px 0 8px;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-3);font:inherit;font-size:13px;cursor:pointer;transition:border-color .15s,color .15s}
.search-btn:hover{border-color:var(--border-2);color:var(--text-2)}
.search-btn kbd{margin-left:auto}
kbd{display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border:1px solid var(--border-2);border-bottom-width:2px;border-radius:5px;background:var(--surface-2);color:var(--text-2);font-size:11px;line-height:16px}
.nav-label{padding:14px 10px 4px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
.side-nav{display:flex;flex-direction:column;gap:1px}
.side-nav a{position:relative;display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--r-sm);color:var(--text-2);font-size:13.5px;font-weight:500;transition:background .12s,color .12s}
.side-nav a svg{width:17px;height:17px;color:var(--text-3);transition:color .12s}
.side-nav a:hover{background:var(--surface-2);color:var(--text)}
.side-nav a:hover svg{color:var(--text-2)}
.side-nav a.on{background:var(--surface-3);color:var(--text);box-shadow:inset 0 0 0 1px var(--border)}
.side-nav a.on svg{color:var(--accent)}
.side-nav a.on::before{content:"";position:absolute;left:-12px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.side-nav .count{margin-left:auto;min-width:20px;padding:0 6px;border-radius:999px;background:var(--surface-3);color:var(--text-2);font-size:11px;font-weight:600;line-height:18px;text-align:center}
.side-nav .count.warn{background:var(--warn-soft);color:var(--warn)}
.side-nav .count.neg{background:var(--neg-soft);color:var(--neg)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding-top:12px;border-top:1px solid var(--border)}
.who{display:flex;align-items:center;gap:10px;padding:6px 8px}
.who .meta{min-width:0;flex:1;line-height:1.25}
.who .meta b{display:block;font-size:13px;font-weight:600}
.who .meta span{font-size:11.5px;color:var(--text-3)}
.side-actions{display:flex;gap:6px}
.side-actions form{flex:1;display:flex}
.side-actions .btn{flex:1}
.main{min-width:0;display:flex;flex-direction:column}
.topbar{display:none}
.content{width:100%;max-width:1360px;margin:0 auto;padding:28px 32px 72px}
.backdrop{display:none}

/* theme toggle shows the icon of the current theme */
.light-only{display:none}
:root[data-theme="light"] .light-only{display:block}
:root[data-theme="light"] .dark-only{display:none}
.crumbs .sep{width:13px;height:13px;color:var(--text-3)}

/* ---------- page header ---------- */
.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:14px 20px;margin:0 0 22px}
.page-head h1{font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.02em}
.page-head .sub{margin-top:4px;color:var(--text-2);font-size:13px}
.page-head .sub .dot{display:inline-block;width:3px;height:3px;margin:0 7px 2px;border-radius:50%;background:var(--text-3);vertical-align:middle}
.crumbs{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12.5px;color:var(--text-3)}
.crumbs a{color:var(--text-2)}
.crumbs a:hover{color:var(--accent)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.live{display:inline-flex;align-items:center;gap:6px}
.live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--pos);box-shadow:0 0 0 3px var(--pos-soft)}
.live.idle::before{background:var(--text-3);box-shadow:0 0 0 3px var(--muted-soft)}

/* ---------- controls ---------- */
.seg{display:inline-flex;padding:3px;gap:2px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
.seg a,.seg button,.seg summary{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:0;border-radius:7px;background:none;color:var(--text-2);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap;list-style:none}
.seg summary::-webkit-details-marker{display:none}
.seg a:hover,.seg summary:hover{color:var(--text);background:var(--surface-2)}
.seg .on,.seg a.on{background:var(--surface-3);color:var(--text);box-shadow:var(--shadow-sm),inset 0 0 0 1px var(--border-2)}
.seg .n{color:var(--text-3);font-size:11.5px;font-variant-numeric:tabular-nums}
.seg .on .n{color:var(--text-2)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 13px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font:inherit;font-size:13px;font-weight:550;line-height:1;white-space:nowrap;cursor:pointer;box-shadow:var(--shadow-sm);transition:background .12s,border-color .12s,color .12s,box-shadow .12s,transform .06s}
.btn:hover{background:var(--surface-2);border-color:var(--border-2);color:var(--text)}
.btn:active{transform:translateY(1px)}
.btn svg{width:15px;height:15px;color:var(--text-2)}
.btn.primary{background:var(--accent);border-color:transparent;color:var(--accent-ink);box-shadow:0 1px 2px rgba(0,0,0,.2),inset 0 1px 0 rgba(255,255,255,.18)}
.btn.primary svg{color:inherit}
.btn.primary:hover{filter:brightness(1.07);color:var(--accent-ink)}
.btn.ghost{background:transparent;border-color:transparent;box-shadow:none;color:var(--text-2)}
.btn.ghost:hover{background:var(--surface-2);color:var(--text)}
.btn.danger{color:var(--neg)}
.btn.danger svg{color:var(--neg)}
.btn.danger:hover{background:var(--neg-soft);border-color:transparent}
.btn.sm{height:28px;padding:0 9px;font-size:12.5px;border-radius:7px}
.btn.icon{width:34px;padding:0}
.btn.icon.sm{width:28px}
.btn.block{width:100%}
input,select,textarea{font:inherit;color:var(--text)}
.input,.select,input[type=text],input[type=search],input[type=number],input[type=date],input[type=password],input:not([type]),select,textarea{
  height:34px;width:100%;min-width:0;padding:0 11px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font-size:13.5px;box-shadow:var(--shadow-sm);transition:border-color .12s,box-shadow .12s}
textarea{height:auto;padding:8px 11px;resize:vertical}
input::placeholder,textarea::placeholder{color:var(--text-3)}
input:hover,select:hover,textarea:hover{border-color:var(--text-3)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input[type=date]{min-width:140px}
input[readonly]{background:var(--surface-2);color:var(--text-2)}
select{appearance:none;-webkit-appearance:none;padding-right:30px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238792A4' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:var(--accent)}
.field{display:flex;flex-direction:column;gap:6px;min-width:0}
.field>span,.label{font-size:12px;font-weight:550;color:var(--text-2)}
.field .hint{font-size:12px;color:var(--text-3);font-weight:400}
.search{position:relative;display:flex;align-items:center}
.search svg{position:absolute;left:10px;width:15px;height:15px;color:var(--text-3);pointer-events:none}
.search input{padding-left:32px}
.check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);cursor:pointer}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;align-items:end}
.form-grid .wide{grid-column:span 2}
.form-actions{display:flex;align-items:center;gap:10px;margin-top:14px}
.toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;margin:0 0 14px}
.toolbar .field{min-width:150px}
.toolbar .field.q{flex:1 1 260px}

/* ---------- cards & grids ---------- */
.card{border:1px solid var(--border);border-radius:var(--r);background:var(--surface);box-shadow:var(--shadow-sm)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px 0}
.card-head h2,.card-head h3{font-size:14px;font-weight:600;color:var(--text)}
.card-head .muted,.card-head p{font-size:12.5px}
.card-body{padding:16px 18px 18px}
.card-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--border);font-size:12.5px;color:var(--text-2)}
.grid{display:grid;gap:16px}
.g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.g3{grid-template-columns:repeat(3,minmax(0,1fr))}
.g-main{grid-template-columns:minmax(0,1.65fr) minmax(0,1fr)}
.g-side{grid-template-columns:minmax(0,1fr) 340px}
.stack{display:flex;flex-direction:column;gap:16px}
.section{margin-top:26px}
h2.section-title,.section>h2{margin:0 0 12px;font-size:15px;font-weight:600}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}
.section-head h2{font-size:15px;font-weight:600}

/* ---------- KPI tiles ---------- */
.tiles{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.tile{position:relative;display:flex;flex-direction:column;min-width:0;padding:14px 16px 12px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);box-shadow:var(--shadow-sm);overflow:hidden;transition:border-color .15s,box-shadow .15s}
.tile:hover{border-color:var(--border-2);box-shadow:var(--shadow)}
.tl{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:550;color:var(--text-2)}
.tv{margin:6px 0 2px;font-size:24px;font-weight:650;line-height:1.15;letter-spacing:-.025em;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ts{min-height:20px;font-size:12px;color:var(--text-3);line-height:1.45}
.ts .muted{color:var(--text-3)}
.tile .spark{margin-top:8px}
.delta{display:inline-flex;align-items:center;gap:2px;padding:0 6px;border-radius:999px;font-size:11.5px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums}
.delta.pos,.ts .pos{background:var(--pos-soft);color:var(--pos)}
.delta.neg,.ts .neg{background:var(--neg-soft);color:var(--neg)}
.ts .pos,.ts .neg{display:inline-block;padding:0 6px;border-radius:999px;font-weight:600}
.spark{width:100%;height:30px;overflow:visible}
.spark .line{fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.spark .area{fill:var(--accent-soft);stroke:none}
.spark.flat .line{stroke:var(--border-2)}
.tile.money .spark .line{stroke:var(--c-ftd)}
.tile.money .spark .area{fill:var(--pos-soft)}

/* ---------- charts ---------- */
.chart{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-rows:220px auto;column-gap:10px}
.chart .yax{display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums;line-height:1;transform:translateY(-.5em)}
.chart .yax.r{align-items:flex-start}
.chart .yax span:last-child{transform:translateY(.5em)}
.chart .plot{position:relative;min-width:0;border-bottom:1px solid var(--border-2)}
.chart .plot svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.chart .grid line{stroke:var(--grid);stroke-width:1;vector-effect:non-scaling-stroke}
.chart .bar{fill:var(--c-rev);opacity:.85}
.chart .bar.spend{fill:var(--text-3);opacity:.35}
.chart .line{fill:none;stroke:var(--c-ftd);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.chart .hits{position:absolute;inset:0;display:flex}
.chart .hits span{flex:1;border-radius:4px;transition:background .1s}
.chart .hits span:hover,.chart .hits span.on{background:var(--hairline);box-shadow:inset 0 0 0 1px var(--grid)}
.chart .xax{grid-column:2;display:flex;padding-top:8px;font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums}
.chart .xax span{flex:1;min-width:0;text-align:center;white-space:nowrap;overflow:visible}
.chart-empty{display:grid;place-items:center;height:220px;color:var(--text-3);font-size:13px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--text-2)}
.legend i{display:inline-block;width:9px;height:9px;margin-right:6px;border-radius:3px;vertical-align:-1px}
.legend i.rev{background:var(--c-rev)}
.legend i.ftd{background:var(--c-ftd);height:3px;width:12px;border-radius:2px;vertical-align:2px}
.legend i.spend{background:var(--text-3);opacity:.5}
.tip{position:fixed;z-index:80;max-width:260px;padding:8px 10px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface-2);box-shadow:var(--shadow-lg);color:var(--text);font-size:12px;line-height:1.5;pointer-events:none;white-space:pre-line;font-variant-numeric:tabular-nums}
.tip[hidden]{display:none}

/* funnel */
.funnel{display:flex;flex-direction:column;gap:14px}
.fhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:6px}
.fhead .fl{font-size:13px;color:var(--text-2)}
.fhead .fv{font-weight:650;font-variant-numeric:tabular-nums}
.frate{margin-top:4px;font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums}
.fbar{height:8px;border-radius:999px;background:var(--surface-3);overflow:hidden}
.fbar svg{width:100%;height:100%}
.fbar rect{fill:var(--accent)}

/* attribution quality */
.q .qbar{display:block;width:100%;height:10px;margin:4px 0 14px;border-radius:999px;overflow:hidden;background:var(--surface-3)}
.q div.row{display:flex;align-items:baseline;gap:10px;padding:8px 0;border-top:1px solid var(--border);font-variant-numeric:tabular-nums}
.q div.row:first-of-type{border-top:0}
.q .dot{flex:none;width:8px;height:8px;border-radius:3px;align-self:center}
.q .dot.matched{background:var(--c-ftd)}.q .dot.parked{background:var(--c-parked)}.q .dot.expired{background:var(--c-expired)}.q .dot.ignored{background:transparent;box-shadow:inset 0 0 0 1.5px var(--text-3)}
.q .lab{width:72px;color:var(--text-2);font-size:13px}
.q .pc{width:64px;text-align:right;font-weight:600}
.q .muted{font-size:12.5px;color:var(--text-3)}
.qbar .m{fill:var(--c-ftd)}.qbar .p{fill:var(--c-parked)}.qbar .x{fill:var(--c-expired)}

/* mini bars inside table cells */
.mbar{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.mbar svg{width:56px;height:6px;border-radius:999px;background:var(--surface-3);overflow:hidden}
.mbar rect{fill:var(--c-rev)}

/* ---------- tables ---------- */
.tw{position:relative;overflow:auto;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);box-shadow:var(--shadow-sm)}
.card>.tw{border:0;border-radius:0 0 var(--r) var(--r);box-shadow:none;border-top:1px solid var(--border)}
table{width:100%;border-collapse:separate;border-spacing:0}
th,td{padding:10px 12px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)}
th:first-child,td:first-child{padding-left:16px}
th:last-child,td:last-child{padding-right:16px}
th{position:sticky;top:0;z-index:2;background:var(--surface-2);color:var(--text-3);font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
th a{display:inline-flex;align-items:center;gap:4px;color:var(--text-3)}
th a:hover{color:var(--text)}
th a.on{color:var(--text)}
td{font-size:13.5px;color:var(--text)}
tbody tr:last-child>td{border-bottom:0}
tbody tr{transition:background .1s}
tbody tr:hover>td{background:var(--hairline)}
tr[data-href]{cursor:pointer}
td.n,th.n{text-align:right}
td a.link,td .link{color:var(--text);font-weight:550}
td a.link:hover{color:var(--accent)}
td.sub{padding-top:0}
tr.detail>td{padding:0 14px 12px;background:var(--surface-2);white-space:normal}
tr.detail:hover>td{background:var(--surface-2)}
tr.total>td{background:var(--surface-2);font-weight:650;border-top:1px solid var(--border-2)}
.cell-main{display:flex;align-items:center;gap:10px;min-width:0}
.cell-main .t{display:flex;flex-direction:column;line-height:1.3;min-width:0}
.cell-main .t small{font-size:12px;color:var(--text-3)}
.ellipsis{max-width:260px;overflow:hidden;text-overflow:ellipsis}

/* ---------- pills, tags, chips ---------- */
.tag,.pill{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:550;line-height:20px;white-space:nowrap;background:var(--muted-soft);color:var(--text-2)}
.tag::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.t-matched{background:var(--pos-soft);color:var(--pos)}
.t-parked{background:var(--warn-soft);color:var(--warn)}
.t-new{background:var(--info-soft);color:var(--info)}
.t-expired,.t-ignored{background:var(--muted-soft);color:var(--text-2)}
.t-failed,.t-firing{background:var(--neg-soft);color:var(--neg)}
.t-ok,.t-sent,.t-clear,.t-on{background:var(--pos-soft);color:var(--pos)}
.t-off,.t-skipped{background:var(--muted-soft);color:var(--text-2)}
.t-pending,.t-stale{background:var(--warn-soft);color:var(--warn)}
.kind{display:inline-flex;align-items:center;justify-content:center;min-width:38px;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.04em;line-height:18px;background:var(--surface-3);color:var(--text-2)}
.kind.ftd{background:var(--pos-soft);color:var(--pos)}
.kind.dep{background:var(--accent-soft);color:var(--accent)}
.kind.reg{background:var(--info-soft);color:var(--info)}
.chip{display:inline-flex;align-items:center;max-width:200px;padding:1px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text-2);font-size:12px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip.path{font-family:var(--mono);font-size:11.5px}
.code,code{padding:1px 6px;border-radius:5px;background:var(--surface-3);color:var(--text);font-size:12px}
.avatar{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:50%;font-size:12px;font-weight:650;color:#fff;letter-spacing:.02em;background:linear-gradient(135deg,var(--a1,#7B8CFF),var(--a2,#A07BFF))}
.avatar.lg{width:56px;height:56px;font-size:20px}
.avatar.h0{--a1:#6366F1;--a2:#8B5CF6}.avatar.h1{--a1:#0EA5E9;--a2:#6366F1}.avatar.h2{--a1:#10B981;--a2:#0EA5E9}.avatar.h3{--a1:#F59E0B;--a2:#EF4444}
.avatar.h4{--a1:#EC4899;--a2:#8B5CF6}.avatar.h5{--a1:#14B8A6;--a2:#22C55E}.avatar.h6{--a1:#F97316;--a2:#EC4899}.avatar.h7{--a1:#64748B;--a2:#334155}

/* ---------- key/value ---------- */
.kv{display:grid;grid-template-columns:150px minmax(0,1fr);gap:0;margin:0}
.kv .k,.kv>div:nth-child(odd){padding:9px 0;color:var(--text-3);font-size:13px;border-top:1px solid var(--border)}
.kv>div:nth-child(even){padding:9px 0;min-width:0;border-top:1px solid var(--border);overflow-wrap:anywhere}
.kv>div:nth-child(1),.kv>div:nth-child(2){border-top:0}

/* ---------- banners, flash, empty ---------- */
.flash,.banner{display:flex;align-items:flex-start;gap:10px;margin:0 0 16px;padding:11px 14px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface);font-size:13.5px;line-height:1.5}
.flash svg,.banner svg{width:17px;height:17px;margin-top:1px}
.flash.ok,.banner.ok{border-color:color-mix(in srgb,var(--pos) 35%,transparent);background:var(--pos-soft)}
.flash.ok svg,.banner.ok svg{color:var(--pos)}
.flash.err,.banner.err{border-color:color-mix(in srgb,var(--neg) 35%,transparent);background:var(--neg-soft)}
.flash.err svg,.banner.err svg{color:var(--neg)}
.banner.warn{border-color:color-mix(in srgb,var(--warn) 35%,transparent);background:var(--warn-soft)}
.banner.warn svg{color:var(--warn)}
.banner .muted{color:var(--text-2)}
.flash .copy-row{margin-top:10px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:40px 20px;text-align:center;color:var(--text-2);font-size:13.5px}
.empty .ico{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--surface-3);color:var(--text-3);margin-bottom:4px}
.empty .ico svg{width:20px;height:20px}
.empty b{color:var(--text);font-weight:600}
.card .empty{padding:32px 20px}
.notes{margin-top:12px;font-size:12.5px;line-height:1.6;color:var(--text-2)}
.notes p+p{margin-top:4px}

/* ---------- attention list ---------- */
.attn{display:flex;flex-direction:column}
.attn a{display:flex;align-items:center;gap:12px;padding:11px 18px;border-top:1px solid var(--border);color:var(--text)}
.attn a:first-child{border-top:0}
.attn a:hover{background:var(--hairline);color:var(--text)}
.attn .ico{display:grid;place-items:center;width:30px;height:30px;border-radius:8px}
.attn .ico svg{width:16px;height:16px}
.attn .ico.warn{background:var(--warn-soft);color:var(--warn)}.attn .ico.neg{background:var(--neg-soft);color:var(--neg)}.attn .ico.info{background:var(--info-soft);color:var(--info)}
.attn .t{flex:1;min-width:0;line-height:1.35}
.attn .t small{display:block;color:var(--text-3);font-size:12px}
.attn .chev{width:16px;height:16px;color:var(--text-3)}

/* ---------- feed ---------- */
.feed{display:flex;flex-direction:column}
.feed a{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;padding:10px 18px;border-top:1px solid var(--border);color:var(--text)}
.feed a:first-child{border-top:0}
.feed a:hover{background:var(--hairline);color:var(--text)}
.feed .t{min-width:0;line-height:1.35}
.feed .t b{font-weight:600;font-variant-numeric:tabular-nums}
.feed .t small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-3);font-size:12px}
.feed time{font-size:12px;color:var(--text-3);white-space:nowrap}

/* ---------- rank list (top campaigns) ---------- */
.rank{display:flex;flex-direction:column;gap:12px}
.rank .r{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center}
.rank .r .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.rank .r .val{font-weight:600;font-variant-numeric:tabular-nums;font-size:13px}
.rank .r .val small{color:var(--text-3);font-weight:500;margin-left:6px}
.rank .r svg{grid-column:1/-1;width:100%;height:6px;border-radius:999px;background:var(--surface-3);overflow:hidden}
.rank .r rect{fill:var(--c-rev)}

/* ---------- profile ---------- */
.profile{display:flex;flex-wrap:wrap;align-items:center;gap:16px;padding:20px}
.profile .who-big{flex:1;min-width:220px}
.profile h1{font-size:20px;font-weight:650;letter-spacing:-.02em}
.profile .meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:6px;font-size:13px;color:var(--text-2)}

/* ---------- timeline ---------- */
.timeline{list-style:none;margin:0;padding:6px 18px 14px}
.timeline li{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:start;padding:10px 0 10px 18px}
.timeline li::before{content:"";position:absolute;left:4px;top:0;bottom:0;width:1px;background:var(--border)}
.timeline li::after{content:"";position:absolute;left:0;top:16px;width:9px;height:9px;border-radius:50%;background:var(--surface);box-shadow:inset 0 0 0 2px var(--text-3)}
.timeline li.ftd::after{box-shadow:inset 0 0 0 2px var(--c-ftd)}
.timeline li.dep::after{box-shadow:inset 0 0 0 2px var(--c-rev)}
.timeline .t{line-height:1.4;min-width:0}
.timeline .t small{display:block;color:var(--text-3);font-size:12px}
.timeline time{font-size:12px;color:var(--text-3);white-space:nowrap}

/* ---------- code & disclosure ---------- */
pre{margin:0;padding:12px 14px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--text-2);font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:360px}
details>summary{cursor:pointer;list-style:none;user-select:none}
details>summary::-webkit-details-marker{display:none}
.disclose>summary{display:inline-flex;align-items:center;gap:6px;padding:4px 0;color:var(--text-2);font-size:12.5px;font-weight:550}
.disclose>summary svg{width:14px;height:14px;transition:transform .15s}
.disclose[open]>summary svg{transform:rotate(90deg)}
.disclose>summary:hover{color:var(--text)}
.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;padding-top:6px}
.detail-grid h4{margin:0 0 6px;font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)}
.attach{padding:12px 14px;border:1px dashed var(--border-2);border-radius:var(--r-sm);background:var(--surface)}
.attach .form-grid{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.pop{position:relative}
.pop>summary{list-style:none}
.pop-body{position:absolute;right:0;top:calc(100% + 8px);z-index:40;width:300px;padding:14px;border:1px solid var(--border-2);border-radius:var(--r);background:var(--surface);box-shadow:var(--shadow-lg)}
.pop-body .form-grid{grid-template-columns:1fr 1fr}

/* ---------- pager ---------- */
.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;font-size:13px}
.pager .muted{color:var(--text-2)}
.pg{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font-size:13px;font-weight:550;box-shadow:var(--shadow-sm)}
.pg:hover{background:var(--surface-2);color:var(--text)}
.pg.off{color:var(--text-3);background:transparent;box-shadow:none;border-color:var(--border);cursor:default}

/* ---------- copy field ---------- */
.copy{display:flex;align-items:center;gap:6px;min-width:0;max-width:640px}
.copy input{flex:1;font-family:var(--mono);font-size:12.5px;height:32px}
.copy .btn{height:32px}
.copy-label{display:block;margin-bottom:6px;font-size:12px;font-weight:550;color:var(--text-2)}

/* ---------- status list (system) ---------- */
.status{display:flex;flex-direction:column}
.status .s{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--border);font-size:13.5px}
.status .s:first-child{border-top:0}
.status .s>span:first-child{color:var(--text-2)}
.status .s>span:last-child{text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sys-head{display:flex;align-items:center;gap:10px}
.sys-head .ico{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--surface-3);color:var(--text-2)}
.sys-head .ico svg{width:16px;height:16px}

/* ---------- command palette ---------- */
.cmdk{position:fixed;inset:0;z-index:90;display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;background:rgba(5,7,12,.55);backdrop-filter:blur(3px)}
:root[data-theme="light"] .cmdk{background:rgba(15,23,40,.25)}
.cmdk[hidden]{display:none}
.cmdk-box{width:100%;max-width:620px;overflow:hidden;border:1px solid var(--border-2);border-radius:14px;background:var(--surface);box-shadow:var(--shadow-lg)}
.cmdk-in{display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--border)}
.cmdk-in svg{width:18px;height:18px;color:var(--text-3)}
.cmdk-in input{flex:1;height:52px;padding:0;border:0;background:transparent;box-shadow:none;font-size:15px}
.cmdk-in input:focus{box-shadow:none}
.cmdk-list{max-height:min(420px,60vh);overflow:auto;padding:6px}
.cmdk-group{padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3)}
.cmdk-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;color:var(--text);cursor:pointer}
.cmdk-item svg{width:16px;height:16px;color:var(--text-3)}
.cmdk-item .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmdk-item small{color:var(--text-3);font-size:12px}
.cmdk-item.on{background:var(--accent-soft)}
.cmdk-item.on svg{color:var(--accent)}
.cmdk-empty{padding:26px;text-align:center;color:var(--text-3);font-size:13px}
.cmdk-foot{display:flex;gap:14px;padding:9px 14px;border-top:1px solid var(--border);color:var(--text-3);font-size:11.5px}

/* ---------- login & error pages ---------- */
.solo{display:grid;place-items:center;min-height:100vh;padding:24px;background:
  radial-gradient(700px 400px at 50% -10%,var(--accent-soft),transparent 70%),var(--bg)}
.solo-card{width:100%;max-width:380px;padding:28px;border:1px solid var(--border);border-radius:16px;background:var(--surface);box-shadow:var(--shadow-lg)}
.solo-card .brand{justify-content:center;padding:0 0 18px;font-size:17px}
.solo-card h1{font-size:18px;text-align:center}
.solo-card .lead{margin:6px 0 20px;text-align:center;color:var(--text-2);font-size:13.5px}
.solo-card form{display:flex;flex-direction:column;gap:14px}
.solo-card .flash{margin:0}
.solo-foot{margin-top:18px;text-align:center;font-size:12px;color:var(--text-3)}
.err-code{font-size:52px;font-weight:700;letter-spacing:-.04em;line-height:1;background:linear-gradient(135deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent;text-align:center}

/* ---------- misc ---------- */
.tagblock{display:block;margin:6px 0 10px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--text);font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;user-select:all}
.detail-grid h4+.tagblock{margin-top:0}
td .inline-form{margin-left:6px}
.tw.adlinks .copy{min-width:300px}
.tw.adlinks .copy input{min-width:200px}
.tw.adlinks tr.detail .detail-grid{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.grid.top{align-items:start}
.sticky{position:sticky;top:24px}
.card.fill{display:flex;flex-direction:column}
.card.fill>.card-body{flex:1;display:flex;flex-direction:column}
.card.fill .chart{flex:1;grid-template-rows:minmax(220px,1fr) auto}
.card.fill .chart-empty{flex:1;height:auto;min-height:220px}
.copy-inline{display:inline-flex;align-items:center;gap:4px}
.copy-inline .mono{font-size:13px}
.btn.copied,.btn.copied svg{color:var(--pos)}
.cell-member{display:flex;align-items:center;gap:10px;min-width:0}
.cell-member .t{display:flex;flex-direction:column;min-width:0;line-height:1.3}
.cell-member .t small{font-size:12px;color:var(--text-3);font-variant-numeric:tabular-nums}
.cell-member .t a{max-width:220px;overflow:hidden;text-overflow:ellipsis}
tr.group>td{padding:8px 14px;background:var(--surface-2);font-size:12px;font-weight:600;color:var(--text-2);letter-spacing:.01em}
tr.group>td b{color:var(--text);font-variant-numeric:tabular-nums}
tr.group:hover>td{background:var(--surface-2)}
tr.group .dot{display:inline-block;width:3px;height:3px;margin:0 8px 2px;border-radius:50%;background:var(--text-3);vertical-align:middle}
.row-actions{display:flex;flex-direction:column;gap:6px;padding-top:4px}
.inline-form{display:inline-flex;margin-left:8px;vertical-align:middle}
.copy-row{margin-top:12px}
.copy-row:first-child{margin-top:0}
.solo-card.in-app{margin:48px auto}
.solo-card .err-code+h1{margin-top:6px}
.section-head .actions{gap:10px}
td .mono,td.mono{font-size:12.5px;color:var(--text-2)}

/* ---------- responsive ---------- */
@media (max-width:1280px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1100px){.g-main,.g-side{grid-template-columns:minmax(0,1fr)}.g3{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){
  .app{grid-template-columns:minmax(0,1fr)}
  .app::before{display:none}
  .side{background:var(--bg-2);border-right-color:var(--border);position:fixed;left:0;top:0;bottom:0;width:min(var(--side),86vw);transform:translateX(-102%);transition:transform .2s ease;box-shadow:var(--shadow-lg)}
  body.nav-open .side{transform:none}
  body.nav-open .backdrop{display:block;position:fixed;inset:0;z-index:25;background:rgba(5,7,12,.5)}
  .topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px)}
  .topbar .brand{padding:0;font-size:14px}
  .content{padding:20px 16px 56px}
  .g2,.g3{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:640px){
  .tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .tv{font-size:20px}
  .page-head h1{font-size:19px}
  .page-head{align-items:flex-start}
  .kv{grid-template-columns:minmax(0,1fr)}
  .kv>div:nth-child(even){padding-top:0;border-top:0}
  .fstep{grid-template-columns:84px minmax(0,1fr) 76px}
  .chart{grid-template-rows:180px auto}
  .chart .xax span.odd{visibility:hidden}
  .card.fill .chart{grid-template-rows:minmax(180px,1fr) auto}
  .chart .yax.r{display:none}
  .seg{max-width:100%;overflow-x:auto}
  .pop-body{position:fixed;left:16px;right:16px;top:auto;width:auto}
  th,td{padding:9px 12px}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;
