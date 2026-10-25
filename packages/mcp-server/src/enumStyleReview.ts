import {withTreeSitterRoot, type TreeSitterNode as Node} from "./skeleton/treeSitter.js";
const ORIGIN = Symbol("tl.enumStyleReview");
type Origin = Readonly<{path:string;range:string;body:string;text:string}>;
export function bindEnumStyleReviewOrigin(row: object, origin: Origin): void {
  (row as {[ORIGIN]?:Origin})[ORIGIN] = Object.freeze(origin);
}
export function enumStyleReviewOrigin(row: object): Origin | undefined {
  return (row as {[ORIGIN]?:Origin})[ORIGIN];
}
function children(node: Node): Node[] {
  const out: Node[]=[];
  for(let i=0;i<node.namedChildCount;i++){const child=node.namedChild(i);if(child)out.push(child);}
  return out;
}
/** Positive declaration facts only: no selector/workspace absence or edit inference. */
export async function enumStyleReview(source: {
  path:string;body:string;fullBody:string;startLine:number;endLine:number;
  fresh:boolean;complete:boolean;truncated?:boolean;
}, existing: ReadonlySet<string>): Promise<string | undefined> {
  if (!source.fresh || !source.complete || source.truncated || !source.path.endsWith(".css")
    || source.path.startsWith("/") || source.path.includes("\\") || /[\r\n\0]/u.test(source.path)
    || source.path.split("/").some(part=>!part || part==="." || part==="..")
    || source.startLine!==1 || !Number.isSafeInteger(source.endLine)
    || Buffer.byteLength(source.fullBody,"utf8")>96*1024) return undefined;
  const full=source.fullBody.replace(/\r\n/g,"\n"), body=source.body.replace(/\r\n/g,"\n");
  if (full.includes("\r") || full.includes("\0") || body.replace(/\n$/u,"")!==full.replace(/\n$/u,"")
    || source.endLine!==full.replace(/\n$/u,"").split("\n").length) return undefined;
  const values=[...existing].filter(value=>/^[A-Za-z][A-Za-z0-9_]*$/.test(value))
    .map(value=>value.toLowerCase().replace(/_/g,"-")).sort((a,b)=>b.length-a.length);
  if(values.length<2 || values.length>64)return undefined;
  return withTreeSitterRoot(full,"css",{},root=>{
    if ((root as Node & {hasError?:unknown}).hasError!==false)return undefined;
    const exact=(node:Node)=>full.slice(node.startIndex,node.endIndex);
    const groups=new Map<string,Array<{line:number;scope:boolean;name:string}>>();
    const pending=[{node:root,ancestors:[] as Node[]}];let count=0;
    while(pending.length){
      const {node,ancestors}=pending.pop()!;if(++count>12000)return undefined;
      if(node.type==="declaration"){
        const property=node.childForFieldName("property_name") ?? children(node).find(n=>n.type==="property_name");
        if(!property)continue;
        const name=exact(property);if(!/^--[a-z][a-z0-9-]*$/.test(name))continue;
        const value=values.find(v=>name.endsWith("-"+v));if(!value)continue;
        const prefix=name.slice(0,-value.length);
        const rule=ancestors.at(-2),block=ancestors.at(-1);
        const ruleBlock=rule && children(rule).find(n=>n.type==="block");
        const scope=ancestors.length===3 && ancestors[0]===root && rule?.type==="rule_set"
          && block?.type==="block" && ruleBlock!==undefined
          && full.slice(rule.startIndex,ruleBlock.startIndex).trim()===":root";
        const line=(node.startPosition?.row ?? -2)+1;
        const entries=groups.get(prefix)??[];entries.push({line,scope,name});groups.set(prefix,entries);
        continue;
      }
      for(const child of children(node))pending.push({node:child,ancestors:[...ancestors,node]});
    }
    const eligible=[...groups].filter(([,rows])=>rows.length>=2);
    if(eligible.length!==1)return undefined;
    const [prefix,rows]=eligible[0]!;
    if(rows.length>12 || rows.some(row=>!row.scope || row.line<1)
      || new Set(rows.map(row=>row.name)).size!==rows.length)return undefined;
    const lines=rows.map(row=>row.line).sort((a,b)=>a-b);
    const label=lines.every((line,i)=>i===0 || line===lines[i-1]!+1)
      ? "L"+lines[0]+"-"+lines.at(-1) : lines.map(line=>"L"+line).join(",");
    const aid=label+": :root custom properties "+prefix+"* define enum-value tokens in this stylesheet; these declarations are not CSS class selectors.";
    return Buffer.byteLength(aid,"utf8")<=200 ? aid : undefined;
  });
}
