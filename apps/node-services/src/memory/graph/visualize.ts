import type { StoredWikiGraph } from "./build.js";
import type { TimelineEvent } from "../graph-visualization.js";
import { pairTies, type TieKind } from "./pair-strength.js";

const TYPE_COLORS: Record<string, string> = {
  session: "#3b82f6",
  client: "#f59e0b",
  contact: "#ec4899",
  project: "#10b981",
  topic: "#8b5cf6",
};

/**
 * Render the graph on demand; do not persist a second graph or HTML cache.
 * Native link edges come first; an inferred edge is drawn only for a pair of
 * pages no earlier edge already joins, so each pair shows its strongest tie.
 */
export function renderGraphVisualization(
  graph: StoredWikiGraph,
  options: { embedded?: boolean; events?: TimelineEvent[] } = {},
): string {
  const nodes = graph.nodes
    .filter((node) => node.id !== "index" && !node.id.endsWith("/index"))
    .map((node) => ({ ...node, category: nodeCategory(node.id) }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const types = [...new Set(nodes.map((node) => node.category))].sort();
  const data = JSON.stringify({
    root: options.embedded ? "Knowledge Graph" : graph.root,
    generatedAt: graph.generatedAt,
    types,
    nodes,
    timelineEvents: options.events ?? [],
    edges: visibleEdges(graph, nodeIds),
    typeColors: Object.fromEntries(
      types.map((type) => [
        type,
        TYPE_COLORS[type.toLocaleLowerCase("en-US")] ?? "#64748b",
      ]),
    ),
  })
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Knowledge Graph</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;color:#1d2622;background:#f5f6f2}header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid #d9ded9;background:white}h1{font-size:16px;margin:0}input,button{font:inherit}input[type=search],button{padding:7px 10px;border:1px solid #c7cec9;border-radius:4px;background:white}input[type=search]{min-width:180px}#stats{color:#68736d;margin-left:auto}main{position:relative;height:calc(100vh - 61px);min-height:320px}svg{width:100%;height:100%;display:block}.link{stroke:#879ba0;stroke-opacity:.5}.node{cursor:pointer;stroke:white;stroke-width:1.5}.node:focus{stroke:#17201c;stroke-width:3}.label{font-size:11px;pointer-events:none;fill:#344741}.type-filters{position:absolute;z-index:3;top:12px;left:12px;min-width:170px;max-width:240px;border:1px solid #d9ded9;border-radius:7px;background:#fffffff2;padding:10px 12px;box-shadow:0 3px 14px #17201c12}.type-filters h2{font-size:12px;margin:0 0 8px}.type-actions{display:flex;gap:6px;margin-bottom:7px}.type-actions button{padding:3px 7px;font-size:11px}.type-options{display:grid;gap:6px}.type-option{display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px}.type-option input{margin:0}.type-dot{width:9px;height:9px;border-radius:999px;background:var(--color);flex:none}aside{position:absolute;z-index:4;right:12px;top:12px;bottom:12px;width:min(360px,calc(100% - 24px));overflow:auto;background:#fff;border:1px solid #d9ded9;border-radius:6px;padding:16px;box-shadow:0 4px 24px #17201c15}aside[hidden]{display:none}aside h2{font-size:18px}aside p,aside pre{white-space:pre-wrap;overflow-wrap:anywhere}aside pre{font:13px/1.6 system-ui}aside button{float:right}#status{position:absolute;left:16px;bottom:12px;color:#68736d}.tag{color:#68736d}
</style></head><body><header><h1>Knowledge Graph</h1><input id="search" type="search" aria-label="Search graph" placeholder="Search pages"><span id="stats"></span></header><main><section class="type-filters" aria-label="Node type filters"><h2>Node types</h2><div class="type-actions"><button id="select-all" type="button">All</button><button id="select-none" type="button">None</button></div><div id="type-options" class="type-options"></div></section><svg aria-label="Knowledge graph" role="img"></svg><p id="status" role="status">Loading graph…</p><aside id="details" hidden aria-label="Page details"></aside></main>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script>
const graph=${data};
const input=document.querySelector('#search'),typeOptions=document.querySelector('#type-options'),details=document.querySelector('#details'),status=document.querySelector('#status');
const color=new Map(Object.entries(graph.typeColors));
const byId=new Map(graph.nodes.map(node=>[node.id,node]));
function text(parent,tag,value){const el=document.createElement(tag);el.textContent=value;parent.append(el);return el;}
function selectedTypes(){return new Set([...typeOptions.querySelectorAll('input[type=checkbox]:checked')].map(input=>input.value));}
function setAllTypes(checked){typeOptions.querySelectorAll('input[type=checkbox]').forEach(input=>{input.checked=checked});draw();}
let draw=()=>{};
for(const name of graph.types){const label=document.createElement('label');label.className='type-option';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=name;checkbox.checked=true;checkbox.setAttribute('aria-label','Show '+name);checkbox.addEventListener('change',()=>draw());const dot=document.createElement('span');dot.className='type-dot';dot.style.setProperty('--color',color.get(name)||'#64748b');label.append(checkbox,dot,document.createTextNode(name));typeOptions.append(label);}
function show(node){details.replaceChildren();const close=text(details,'button','Close');close.onclick=()=>{details.hidden=true};text(details,'h2',node.title);text(details,'p',node.category+' · '+node.tags.join(', ')).className='tag';text(details,'p',node.description);text(details,'h3','Linked pages');const linked=[...new Set([...node.links,...node.backlinks])].map(id=>byId.get(id)).filter(Boolean);for(const page of linked){const button=text(details,'button',page.title);button.style.float='none';button.onclick=()=>show(page);}text(details,'h3','Page content');text(details,'pre',node.body);details.hidden=false;}
if(typeof d3==='undefined'){status.textContent='Graph renderer could not load. Please retry.';}else{
const svg=d3.select('svg'),layer=svg.append('g');const zoom=d3.zoom().scaleExtent([.15,4]).on('zoom',event=>layer.attr('transform',event.transform));svg.call(zoom);let simulation;
draw=()=>{if(simulation)simulation.stop();layer.selectAll('*').remove();const query=input.value.trim().toLowerCase(),types=selectedTypes();const nodes=graph.nodes.filter(node=>types.has(node.category)&&(!query||[node.title,node.description,node.body,...node.tags].join(' ').toLowerCase().includes(query))).map(node=>({...node}));const ids=new Set(nodes.map(node=>node.id));const edges=graph.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)).map(edge=>({...edge}));document.querySelector('#stats').textContent=nodes.length+' pages · '+edges.length+' links';status.textContent=nodes.length?'':'No matching pages.';const width=svg.node().clientWidth,height=svg.node().clientHeight;svg.attr('viewBox',[0,0,width,height]);const links=layer.append('g').selectAll('line').data(edges).join('line').attr('class','link');const circles=layer.append('g').selectAll('circle').data(nodes).join('circle').attr('class','node').attr('r',node=>Math.min(15,5+Math.sqrt(node.size)/22)).attr('fill',node=>color.get(node.category)||'#64748b').attr('tabindex',0).attr('aria-label',node=>node.title).on('click',(_event,node)=>show(node)).on('keydown',(event,node)=>{if(event.key==='Enter')show(node)});circles.append('title').text(node=>node.title);const labels=layer.append('g').selectAll('text').data(nodes).join('text').attr('class','label').text(node=>node.title.length>32?node.title.slice(0,29)+'…':node.title);simulation=d3.forceSimulation(nodes).force('link',d3.forceLink(edges).id(node=>node.id).distance(100)).force('charge',d3.forceManyBody().strength(-180)).force('center',d3.forceCenter(width/2,height/2)).force('collision',d3.forceCollide(24)).on('tick',()=>{links.attr('x1',edge=>edge.source.x).attr('y1',edge=>edge.source.y).attr('x2',edge=>edge.target.x).attr('y2',edge=>edge.target.y);circles.attr('cx',node=>node.x).attr('cy',node=>node.y);labels.attr('x',node=>node.x+12).attr('y',node=>node.y+4)});circles.call(d3.drag().on('start',(event,node)=>{if(!event.active)simulation.alphaTarget(.2).restart();node.fx=node.x;node.fy=node.y}).on('drag',(event,node)=>{node.fx=event.x;node.fy=event.y}).on('end',(event,node)=>{if(!event.active)simulation.alphaTarget(0);node.fx=null;node.fy=null}));};
input.addEventListener('input',draw);document.querySelector('#select-all').onclick=()=>setAllTypes(true);document.querySelector('#select-none').onclick=()=>setAllTypes(false);window.addEventListener('resize',draw);draw();}
</script></body></html>`;
}

function nodeCategory(id: string): string {
  const root = id.split("/", 1)[0]?.toLocaleLowerCase("en-US");
  if (root === "sessions") return "Session";
  if (root === "clients") return "Client";
  if (root === "contacts") return "Contact";
  if (root === "projects") return "Project";
  if (root === "topics") return "Topic";
  return "Other";
}

/**
 * One edge per pair of pages, carrying every tie between them: native links
 * keep their direction and draw solid, a pair tied only by inference draws
 * as its strongest inferred kind, and `strength` is the pair strength.
 */
function visibleEdges(graph: StoredWikiGraph, nodeIds: ReadonlySet<string>) {
  const ties = pairTies(graph);
  const seen = new Set<string>();
  const edges: Array<{
    source: string;
    target: string;
    kind?: "mention";
    strength: number;
    kinds: TieKind[];
    weights: Partial<Record<TieKind, number>>;
  }> = [];
  for (const { source, target } of [
    ...graph.edges,
    ...(graph.inferredEdges ?? []),
  ]) {
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    const pair = [source, target].sort().join("\n");
    if (seen.has(pair)) continue;
    seen.add(pair);
    const tie = ties.get(source)?.get(target);
    if (!tie) continue;
    edges.push({
      source,
      target,
      ...(tie.kinds.includes("link") ? {} : { kind: "mention" as const }),
      strength: tie.strength,
      kinds: tie.kinds,
      weights: tie.weights,
    });
  }
  return edges;
}
