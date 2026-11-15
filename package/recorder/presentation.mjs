// Display-only provenance using browser ranges, independent of private editor modules.
export async function installPredictionColor() {
  const slot = '__PROMPT_PREDICTOR_PRESENTATION';
  if (globalThis[slot]?.status?.revision === 4) return globalThis[slot].status;
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) throw Error('Browser text highlights unavailable');
  const id = 'prompt-predictor-presentation';
  let style = document.getElementById(id);
  if (!style) { style = document.createElement('style'); style.id = id; document.head.append(style); }
  style.textContent = '.ProseMirror [data-cumberbatch] .cumberbatch-content, .ProseMirror [data-cumberbatch] .cumberbatch-content * { color: #fca5a5 !important; } .ProseMirror [data-cumberbatch] .cumberbatch-content { opacity: 1 !important; } ::highlight(prompt-predictor-origin) { color: #ef4444; }';
  const states = new Map();
  const listeners = new AbortController();
  const nodes = editor => {
    const out = [], walk = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) if (!walk.currentNode.parentElement.closest('[data-cumberbatch]')) out.push(walk.currentNode);
    return out;
  };
  const read = editor => nodes(editor).map(n => n.data).join('');
  function remap(ranges, start, end, inserted) {
    const delta = inserted - (end - start);
    return ranges.flatMap(r => {
      const out = [];
      if (r.from < start) out.push({from:r.from, to:Math.min(r.to,start)});
      if (r.to > end) out.push({from:Math.max(r.from,end)+delta, to:r.to+delta});
      return out.filter(r => r.to > r.from);
    });
  }
  function paint() {
    const highlight = new Highlight();
    for (const [editor, state] of states) {
      if (!editor.isConnected) { states.delete(editor); continue; }
      const texts = nodes(editor);
      for (const span of state.ranges) {
        let offset = 0, range = document.createRange(), begun = false;
        for (const node of texts) {
          const end = offset + node.length;
          if (!begun && span.from >= offset && span.from < end) { range.setStart(node, span.from-offset); begun = true; }
          if (begun && span.to <= end) { range.setEnd(node, span.to-offset); highlight.add(range); break; }
          offset = end;
        }
      }
    }
    CSS.highlights.set('prompt-predictor-origin', highlight);
  }
  function sync(editor) {
    const text = read(editor), state = states.get(editor);
    if (!state) return;
    if (state.pending !== undefined && !editor.querySelector('[data-cumberbatch]') && text === state.pending) {
      state.ranges = text.length ? [{from:0,to:text.length}] : [];
      delete state.pending;
    } else if (text !== state.text) {
      let start = 0, oldEnd = state.text.length, newEnd = text.length;
      while (start < oldEnd && start < newEnd && state.text[start] === text[start]) start++;
      while (oldEnd > start && newEnd > start && state.text[oldEnd-1] === text[newEnd-1]) { oldEnd--; newEnd--; }
      // Prefer the actual input selection when repeated characters make a diff ambiguous.
      const edit = state.edit;
      if (edit && text.slice(0,edit.from) === state.text.slice(0,edit.from) && text.slice(text.length-(state.text.length-edit.to)) === state.text.slice(edit.to)) {
        start=edit.from; oldEnd=edit.to; newEnd=text.length-(state.text.length-edit.to);
      }
      state.ranges = remap(state.ranges,start,oldEnd,newEnd-start);
    }
    state.text=text; delete state.edit;
  }
  document.addEventListener('keydown', event => {
    if (!['Tab','ArrowRight','Enter'].includes(event.key) || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const editor=event.target.closest?.('.ProseMirror'), preview=editor?.querySelector('[data-cumberbatch] .cumberbatch-content');
    if (!preview) return;
    const state=states.get(editor) ?? {text:read(editor),ranges:[]};
    state.pending=preview.textContent; states.set(editor,state);
  },{capture:true,signal:listeners.signal});
  document.addEventListener('beforeinput', event => {
    const editor=event.target.closest?.('.ProseMirror'), state=states.get(editor), selection=document.getSelection();
    if (!state || !selection?.rangeCount) return;
    const selected=selection.getRangeAt(0);
    if (!editor.contains(selected.startContainer) || !editor.contains(selected.endContainer)) return;
    const prefix=document.createRange();prefix.selectNodeContents(editor);prefix.setEnd(selected.startContainer,selected.startOffset);
    const from=prefix.toString().length, to=from+selected.toString().length;
    if (event.inputType?.startsWith('insert')) state.edit={from,to};
  },{capture:true,signal:listeners.signal});
  const observer=new MutationObserver(() => { for (const editor of states.keys()) sync(editor); paint(); });
  observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  const status={revision:4,installed:true,previewColor:'#fca5a5',acceptedColor:'#ef4444',mechanism:'browser-highlight'};
  globalThis[slot]={owner:'prompt-predictor-prototype-v1',status,states,sync,paint,remap,observer,dispose(){listeners.abort();observer.disconnect();states.clear();CSS.highlights.delete('prompt-predictor-origin');style.remove();delete globalThis[slot];}};
  return status;
}
