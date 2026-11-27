// `probe` (capture mode only) adds the page time and the paint-probe key of this same synchronous read; see invariants-probe.mjs.
export async function renderedSnapshot(page, { lines, probe = false } = {}) {
  return page.evaluate(({ lines, probe }) => {
    // These caches last for this synchronous snapshot only; the DOM is never written.
    const styles = new WeakMap(), boxes = new WeakMap(), visibility = new WeakMap(), texts = new WeakMap();
    const style = (element) => {if (!styles.has(element)) styles.set(element, getComputedStyle(element)); return styles.get(element);};
    const rect = (element) => {if (!boxes.has(element)) boxes.set(element, element.getBoundingClientRect()); return boxes.get(element);};
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const insetBounds = (value, box) => {
      const match = value.match(/^inset\(([^)]*)\)/);
      if (!match) return null;
      const parts = match[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      if (!parts.length || parts.length > 4) return null;
      const resolve = (part, size) => part.endsWith('%') ? size * parseFloat(part) / 100 : parseFloat(part);
      const [t, r = t, b = t, l = r] = parts;
      return {left:box.left+resolve(l,box.width),right:box.right-resolve(r,box.width),top:box.top+resolve(t,box.height),bottom:box.bottom-resolve(b,box.height)};
    };
    const clipCache = new WeakMap();
    const clipsFor = (element) => {
      if (clipCache.has(element)) return clipCache.get(element);
      const clips = [];
      for (let node=element;node;node=node.parentElement) {
        const css=style(node),box=rect(node),inset=insetBounds(css.clipPath,box);
        if(inset)clips.push(inset);
        const legacy=css.clip.match(/^rect\(([^)]*)\)$/);
        if(legacy) {
          const values=legacy[1].split(/[ ,]+/).map(value=>value==='auto'?null:parseFloat(value));
          if(values.length===4) {
            const [t,r,b,l]=values;
            clips.push({left:box.left+(l??0),right:box.left+(r??box.width),top:box.top+(t??0),bottom:box.top+(b??box.height)});
          }
        }
        const clipX=/(hidden|clip)/.test(css.overflowX),clipY=/(hidden|clip)/.test(css.overflowY);
        if(clipX||clipY)clips.push({left:clipX?box.left:-Infinity,right:clipX?box.right:Infinity,top:clipY?box.top:-Infinity,bottom:clipY?box.bottom:Infinity});
      }
      clipCache.set(element,clips);return clips;
    };
    const paintedRects = (range,parent) => [...range.getClientRects()].filter(box => {
      const clipped = clipsFor(parent).reduce((bounds,clip) => ({left:Math.max(bounds.left,clip.left),right:Math.min(bounds.right,clip.right),top:Math.max(bounds.top,clip.top),bottom:Math.min(bounds.bottom,clip.bottom)}),box);
      return clipped.right > clipped.left && clipped.bottom > clipped.top;
    });
    const computeVisibility = (element) => {
      // Chromium retains layout boxes for closed details content. A nonempty
      // rectangle alone is not evidence that the element is painted.
      if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const css = style(node);
        if (css.display === 'none' || Number(css.opacity) === 0) return false;
        const box = rect(node);
        if (node===element&&(!box.width || !box.height)) return false;
        if (css.clipPath && css.clipPath !== 'none') {
          const clip = insetBounds(css.clipPath, box);
          if (clip && (clip.right <= clip.left || clip.bottom <= clip.top || !overlaps(box, clip))) return false;
        }
        const legacyClip = css.clip.match(/^rect\(([^)]*)\)$/);
        if (legacyClip) {
          const values = legacyClip[1].split(/[ ,]+/).map(value => value === 'auto' ? null : parseFloat(value));
          if (values.length === 4 && values.every(value => value !== null)) {
            const [top, right, bottom, left] = values;
            if (right <= left || bottom <= top) return false;
            if (!overlaps(box, { left: box.left + left, right: box.left + right, top: box.top + top, bottom: box.top + bottom })) return false;
          }
        }
        // A 1px absolute box with hidden overflow is a common geometry-only
        // screen-reader recipe. Its class or data name does not affect visibility.
        if (css.position === 'absolute' && css.overflow === 'hidden' && box.width <= 1 && box.height <= 1) return false;
        if (node !== element && css.position !== 'fixed' && /(hidden|clip)/.test(`${css.overflow} ${css.overflowX} ${css.overflowY}`) && !overlaps(rect(element), box)) return false;
      }
      const box=rect(element);
      return Boolean(box.width&&box.height);
    };
    const isVisible = (element) => {if (!visibility.has(element)) visibility.set(element, computeVisibility(element)); return visibility.get(element);};
    const nodeText = (node) => {
      let value=node.nodeValue;
      if(clipsFor(node.parentElement).length) {
        value='';
        const range=document.createRange();
        for(let offset=0;offset<node.length;offset++) {
          range.setStart(node,offset);range.setEnd(node,offset+1);
          if(paintedRects(range,node.parentElement).length)value+=node.nodeValue[offset];
        }
      }
      const whiteSpace=style(node.parentElement).whiteSpace;
      if(['normal','nowrap'].includes(whiteSpace))return value.replace(/\s+/g,' ');
      if(whiteSpace==='pre-line')return value.replace(/[^\S\n]+/g,' ');
      return value;
    };
    // Traverse text nodes independently: a hidden ancestor may contain a
    // visible override, while a visible container may contain hidden children.
    const visibleText = (root) => {
      if (texts.has(root)) return texts.get(root);
      const parts = [];
      let previousTop;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.nodeValue || !isVisibleText(node)) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const boxes = paintedRects(range,node.parentElement);
        if (!boxes.length) continue;
        if (previousTop !== undefined && Math.abs(boxes[0].top - previousTop) > 1) parts.push('\n');
        parts.push(nodeText(node));
        previousTop = boxes.at(-1).top;
      }
      const text = parts.join('').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
      texts.set(root, text); return text;
    };
    const textOf = (element) => visibleText(element).replace(/\s+/g, ' ').trim();
    const isCode = (node) => !!node.closest('pre, code');
    const isVisibleText = (node) => {
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) return false;
      const closed = parent.closest('details:not([open])');
      if(closed&&!closed.querySelector(':scope > summary')?.contains(node))return false;
      const range=document.createRange();range.selectNodeContents(node);
      return paintedRects(range,parent).length>0;
    };
    const lineTops = (range) => paintedRects(range,range.startContainer.parentElement)
      .map((r) => Math.round(r.top));
    const uniqueLines = (tops) => [...new Set(tops)];
    const bodyText = [];
    const statusEvidenceText = [];
    let statusEvidenceTextTruncated = false;
    const statusEvidencePattern = /Status unavailable|status is not available|not available yet|Lending status could not be confirmed|We can.t tell what happened|Refresh the (?:job|page) to check its status|is unreachable\. Showing what Faravan saved|are unreachable\. Showing what Faravan saved|Last known:/i;
    const tokens = [];
    const sentences = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || !node.nodeValue.trim() || !isVisibleText(node)) continue;
      const fullRange = document.createRange();
      fullRange.selectNodeContents(node);
      if (!fullRange.getClientRects().length) continue;
      const renderedText = nodeText(node);
      bodyText.push(renderedText);
      if (statusEvidencePattern.test(renderedText)) {
        if (statusEvidenceText.length < 12) {
          if (renderedText.length > 1000) statusEvidenceTextTruncated = true;
          statusEvidenceText.push(renderedText.slice(0,1000));
        } else statusEvidenceTextTruncated = true;
      }
      if (!isCode(parent)) {
        const re = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;
        for (const match of node.nodeValue.matchAll(re)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          if (uniqueLines(lineTops(range)).length > 1) tokens.push(match[0] + ' in ' + parent.tagName.toLowerCase() + '.' + String(parent.className || parent.closest('[class]')?.className || '').slice(0, 80));
        }
      }
    }
    const text = bodyText.join(' ').replace(/\s+/g, ' ').trim();

    // Sentence wrapping is a layout signal, not a prose-quality judgment; use rendered word boxes.
    const sentenceRe = /[^.!?]+[.!?]+|[^.!?]+$/g;
    // Build sentence candidates per text node: this preserves real line boxes without inserting DOM.
    const candidateWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (candidateWalker.nextNode()) {
      const node = candidateWalker.currentNode;
      if (!node.parentElement || !isVisibleText(node) || isCode(node.parentElement)) continue;
      for (const match of node.nodeValue.matchAll(sentenceRe)) {
        const words = match[0].trim().split(/\s+/).filter(Boolean);
        if (words.length < 8) continue;
        const lines = new Map();
        for (const word of match[0].matchAll(/\S+/g)) {
          const range=document.createRange();
          range.setStart(node,match.index+word.index);
          range.setEnd(node,match.index+word.index+word[0].length);
          for(const top of uniqueLines(lineTops(range)))lines.set(top,(lines.get(top)||0)+1);
        }
        if ([...lines.values()].filter((count) => count <= 3).length >= 3 && lines.size >= 3) sentences.push(match[0].trim());
      }
    }

    const live = [...document.querySelectorAll('.notice[aria-live], .announcer[aria-live]')]
      .filter((el) => textOf(el)).map(textOf);
    const floatingSaved = [];
    for (const el of [...document.querySelectorAll('body *')]) {
      if (!el.textContent.includes('Saved') || !isVisible(el) || !/^Saved\.?$/.test(textOf(el))) continue;
      let floating = false;
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const css = style(node);
        if (css.position !== 'fixed' && css.position !== 'sticky') continue;
        const bg = css.backgroundColor;
        const transparent = bg === 'transparent' || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(bg);
        const box = rect(node);
        if (!transparent || !box.width || !box.height) continue;
        const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2));
        const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
        const stack = document.elementsFromPoint(x, y);
        if (stack.some((other) => other !== node && !node.contains(other) && !other.contains(node))) {
          floating = true;
          break;
        }
      }
      if (floating) floatingSaved.push(textOf(el));
    }
    const codeLigatures = [...document.querySelectorAll('.diff pre, .diff code, .review-diff pre, .review-diff code, [aria-label="Changes"] pre, [aria-label="Changes"] code')]
      .filter((el) => isVisible(el) && style(el).fontVariantLigatures !== 'none')
      .map((el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? `.${el.className.trim().replace(/\s+/g, '.')}` : ''));
    // Judge r10 R1: a visible element whose text ends at "Last known:" names no state at all.
    const emptyLastKnown = [...document.querySelectorAll('p,span,div,li,dd,td,h1,h2,h3')]
      .filter((el) => isVisible(el) && /Last known:\s*$/.test(textOf(el))).map((el) => textOf(el));
    const visibleButtons = [...document.querySelectorAll('button')].filter(el => isVisible(el) || textOf(el));
    const buttons = visibleButtons.map((el) => ({ text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' }));
    const links = [...document.querySelectorAll('a')].filter(el => isVisible(el) || textOf(el)).map((el) => ({ text: textOf(el), href: el.href }));
    const prose = [...document.querySelectorAll('.result-prose,.job-summary,.request-context-markdown,.transcript-feed')];
    const rawMarkdown = prose.filter((el) => /(?:^|\n)\s*```|\*\*[^*]+\*\*|(?:^|\n)##? |\|\s*-{3}/.test(visibleText(el))).map(() => true);
    const lineGroups = [];
    const panes = [...document.querySelectorAll('.result-prose,.transcript-feed,.job-summary')].filter(el => visibleText(el)).filter((el) => !el.querySelector('.result-prose'));
    for (const pane of panes.length ? panes : [document.body]) {
      const paneText = visibleText(pane);
      if (!lines?.every((line) => paneText.includes(line))) continue;
      const linePositions = {};
      for (const line of lines ?? []) {
        const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, index = node.textContent.indexOf(line);
          if (index < 0 || !isVisibleText(node)) continue;
          const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + line.length);
          const boxes=paintedRects(range,node.parentElement);
          if (boxes.length) { linePositions[line] = boxes[0].top; break; }
        }
      }
      lineGroups.push(linePositions);
    }
    const top = (el) => el ? el.getBoundingClientRect().top + scrollY : null;
    const primary = visibleButtons.find((el) => /Add as a branch/.test(textOf(el)));
    const diff = document.querySelector('[aria-label="Changes"]');
    const badPreformatted = [...document.querySelectorAll('.result-prose pre,.agent-markdown pre')].filter((el) => isVisible(el) && (!['pre','pre-wrap','break-spaces'].includes(style(el).whiteSpace) || !/mono/i.test(style(el).fontFamily))).map(() => true);
    const groupSelector = '.job-page,.rq,.home-jobs a.row,.jlist a.row,.result-card,.request-preview,[data-job-id],[data-request-id]';
    const groups = [...document.querySelectorAll(groupSelector)].filter(el => visibleText(el)).filter((el) => !el.parentElement?.closest(groupSelector));
    const statusGroups = groups.map((group) => {
      const slots = [...group.querySelectorAll('.jh,.wait-card,.activity-intro,.job-timeline,.rq-decide,.rq-card,.row-meta,.hstack')].filter(el => visibleText(el));
      return (slots.length ? slots : [group]).map(textOf).join(' ');
    });
    if (!groups.length && !document.querySelector('.circle-page,.home-page,.jlist')) statusGroups.push(textOf(document.body));
    const summaryText = document.querySelector('.job-summary') ? visibleText(document.querySelector('.job-summary')) : undefined;
    const circleName = document.querySelector('input[aria-label="Circle name"]')?.value;
    const loadingLabels = [...document.querySelectorAll('[role="status"][aria-label^="Loading "]')].filter(isVisible).map((el) => el.getAttribute('aria-label'));
    const bareTools = [...document.querySelectorAll('.transcript-feed li,.feed-line')].filter((el) => /^(Read|Edited|Ran|Write|Wrote)$/.test(textOf(el))).map(() => true);
    const noteButtons = [...document.querySelectorAll('.review-line-note')].filter(isVisible);
    const headers = [...document.querySelectorAll('.pagehead, .page-header, .job-page .jh')].filter(isVisible);
    // A modal sheet is acceptable when it sits inside the viewport on every side, has an accessible name, and every
    // action in it can be brought into view: nothing hides it behind an overflow:hidden/clip box that cannot scroll.
    const modalProblem = (dialog, box) => {
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      if (box.left < -1 || box.top < -1 || box.right > vw + 1 || box.bottom > vh + 1) return 'bounds';
      const named = dialog.getAttribute('aria-label')?.trim() || [...(dialog.getAttribute('aria-labelledby') ?? '').split(/\s+/)].some((id) => id && document.getElementById(id)?.textContent.trim());
      if (!named) return 'unnamed';
      const scrolls = (el) => /auto|scroll/.test(style(el).overflowY) && el.scrollHeight > el.clientHeight;
      const clips = (el) => /hidden|clip/.test(style(el).overflowY) || /hidden|clip/.test(style(el).overflowX);
      for (const action of dialog.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')) {
        let box = action.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        for (let node = action.parentElement; node; node = node.parentElement) {
          const nodeBox = node.getBoundingClientRect();
          if (clips(node) && (box.top < nodeBox.top - 1 || box.bottom > nodeBox.bottom + 1 || box.left < nodeBox.left - 1 || box.right > nodeBox.right + 1)) return 'clipped';
          // A scroll container can bring its content into view, but then only its own box has to fit its parents.
          if (scrolls(node) && !clips(node)) box = nodeBox;
          if (node === dialog) break;
        }
      }
      return '';
    };
    const frameOverflow = [];
    if (headers.length) {
      for (const pageRoot of document.querySelectorAll('.job-page')) {
        const rootBox = rect(pageRoot);
        const header = headers.find((el) => pageRoot.contains(el)) || headers[0];
        const headerBox = rect(header);
        for (const child of pageRoot.children) {
          const box = rect(child);
          // A modal dialog is a top-layer overlay anchored to the viewport, not page content (r8 O14). It leaves the page
          // column only while it is a usable overlay: see modalProblem.
          const problem = child.matches('dialog:modal') ? modalProblem(child, box) : box.width && box.right > headerBox.right + 1 ? 'right' : '';
          if (problem) frameOverflow.push({ child: child.tagName.toLowerCase(), problem, right: Math.round(box.right), headerRight: Math.round(headerBox.right), pageRight: Math.round(rootBox.right) });
        }
      }
    }
    return {
      text,
      statusEvidenceText,
      statusEvidenceTextTruncated,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      overflowingElements: [...document.querySelectorAll('body *')].filter((el) => isVisible(el) && rect(el).right > document.documentElement.clientWidth + 1).slice(0, 4).map((el) => el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 60) + ' right=' + Math.round(rect(el).right)),
      brokenWords: tokens,
      squeezedText: sentences,
      visibleLiveAnnouncements: live,
      floatingSaved,
      emptyLastKnown,
      codeLigatures,
      persistentNoteButtons: innerWidth === 390 ? noteButtons.length : 0,
      frameOverflow,
      buttons,
      links,
      rawMarkdown, lineGroups, statusGroups, primaryTop: top(primary), diffTop: top(diff),
      defaultSerif: /Times|serif/i.test(style(document.body).fontFamily) && !/sans-serif/i.test(style(document.body).fontFamily),
      badPreformatted, summaryText, circleName, loadingLabels, bareTools,
      ...(probe ? {pageAt: performance.timeOrigin + performance.now(), probeKey: window.__invariantProbeKey?.() ?? null} : {}),
    };
  }, { lines, probe });
}
