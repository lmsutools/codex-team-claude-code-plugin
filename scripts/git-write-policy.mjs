/** Refuse writes that would require configured filter programs; never stage unfiltered substitutes. */
export function guardFilteredWrite(args, keys, run) {
  const writing=["add","commit","cherry-pick","merge","checkout","switch","restore","reset","apply"].includes(args[0]) || args[0]==="worktree" && args[1]==="add";
  if(!writing) return false;
  const drivers=new Set(keys.filter(k=>/^filter\..*\.(clean|smudge|process|required)$/i.test(k)).map(k=>k.slice(7,k.lastIndexOf("."))));
  if(!drivers.size) return true;
  const sources=[null];
  if(!["add","commit"].includes(args[0])) for(const token of ["HEAD",...args.slice(1).filter(v=>!v.startsWith("-"))]) {
    const ref=run(["rev-parse","--verify","--end-of-options",token+"^{tree}"],{},true);
    if(ref.status===0) sources.push(ref.stdout.trim());
  }
  for(const source of [...new Set(sources)]) {
    const listed=run(source?["ls-tree","-r","--name-only","-z",source]:["ls-files","--cached","--others","--exclude-standard","-z"]);
    const names=listed.stdout.split("\0").filter(Boolean);
    // Conservative across the checkout/index: writes cannot bypass the guard through pathspecs.
    const attrs=run(["check-attr",...(source?["--source="+source]:[]),"-z","--stdin","filter"],{input:names.join("\0")+"\0"}).stdout.split("\0");
    for(let i=0;i+2<attrs.length;i+=3) if(drivers.has(attrs[i+2])) throw Error(`These paths use Git filter ${attrs[i+2]}; commit them yourself - codex-team does not run filter programs. Path: ${attrs[i]}`);
  }
  return true;
}
