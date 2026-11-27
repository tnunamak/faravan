import {lexer} from 'marked';
import {useLayoutEffect, useRef, useState} from 'preact/hooks';
import {Card} from './ds/index.mjs';
import {Action} from './shared.jsx';
import {ImagePreview} from './image-preview.jsx';
import './agent-markdown.css';

// Only these elements are constructed. Raw HTML and unknown tokens stay text;
// links allow web URLs and fragments, images never make remote requests.
const safeHref = value => /^(https?:\/\/|#)/i.test(value || '') ? value : null;
function Inline({tokens=[]}) {
  return tokens.map(token=>{
    const children=<Inline tokens={token.tokens || []} />;
    switch(token.type){
      case 'strong':return <strong>{children}</strong>;
      case 'em':return <em>{children}</em>;
      case 'del':return <del>{children}</del>;
      case 'codespan':return <code>{token.text}</code>;
      case 'br':return <br />;
      case 'link':return safeHref(token.href)?<a href={safeHref(token.href)} target="_blank" rel="noopener noreferrer">{children}</a>:children;
      case 'image':return <span>{token.text || 'Image'}</span>;
      default:return token.tokens?children:token.text || token.raw || '';
    }
  });
}
function MarkdownTable({token}) {
  const pane=useRef(),[more,setMore]=useState(false);
  const measure=()=>{const el=pane.current;if(el)setMore(el.scrollWidth-el.clientWidth-el.scrollLeft>2);};
  useLayoutEffect(()=>{
    measure();const observer=new ResizeObserver(measure);observer.observe(pane.current);
    return ()=>observer.disconnect();
  },[token]);
  return <div class={'result-table-frame'+(more?' has-more':'')}><div ref={pane} class="result-table" tabIndex="0" role="region" aria-label="Markdown table" onScroll={measure}><table><thead><tr>{token.header.map(cell=><th><Inline tokens={cell.tokens}/></th>)}</tr></thead><tbody>{token.rows.map(row=><tr>{row.map(cell=><td><Inline tokens={cell.tokens}/></td>)}</tr>)}</tbody></table></div>{more&&<p class="result-table-hint t-xs t-2">Scroll to see all columns.</p>}</div>;
}
function Blocks({tokens=[]}) {
  return tokens.map(token=>{
    switch(token.type){
      case 'space':return null;
      case 'heading':{const Tag='h'+Math.min(4,Math.max(3,token.depth));return <Tag><Inline tokens={token.tokens}/></Tag>;}
      case 'paragraph':return <p><Inline tokens={token.tokens}/></p>;
      case 'text':return token.tokens?<p><Inline tokens={token.tokens}/></p>:<p>{token.text}</p>;
      case 'code':return <pre tabIndex="0"><code>{token.text}</code></pre>;
      case 'blockquote':return <blockquote><Blocks tokens={token.tokens}/></blockquote>;
      case 'list':{const Tag=token.ordered?'ol':'ul';return <Tag start={token.ordered?token.start:undefined}>{token.items.map(item=><li>{item.task && <span role="img" aria-label={item.checked ? 'Completed task' : 'Incomplete task'}>{item.checked ? '☑' : '☐'} </span>}<Blocks tokens={item.tokens}/></li>)}</Tag>;}
      case 'table':return <MarkdownTable token={token}/>;
      case 'hr':return <hr/>;
      default:return <p>{token.text || token.raw || ''}</p>;
    }
  });
}
export function Markdown({text='',className=''}) {
  return <div class={('result-prose' + (className ? ' ' + className : '')) + ' ph-no-capture'} data-telemetry-private="result-reader"><Blocks tokens={lexer(text,{gfm:true,breaks:true})}/></div>;
}
export async function downloadOutput(api,url) {
  const result=await api.download(url.replace(/^\/api\//,'')),objectUrl=URL.createObjectURL(result.blob),link=document.createElement('a');
  link.href=objectUrl;link.download=result.filename;link.classList.add('ph-no-capture'); link.setAttribute('data-telemetry-private', 'result-reader-download'); document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),2000);
}
export async function copyOutputMessage(api,message) {
  const text=message.truncated && api ? await (await api.download(message.url.replace(/^\/api\//,''))).blob.text() : message.markdown;
  await navigator.clipboard.writeText(text);
}
export function ResultReader({data,api,showCopy=true,showActions=true,showFileActions=true}) {
  const message=data.message;
  const downloadMessage=()=>downloadOutput(api,message.url);
  const copyMessage=()=>copyOutputMessage(api,message);
  return <section class="stack-4 ph-no-capture" aria-label="Result" data-telemetry-private="result-reader">
    {data.warning&&<p class="banner warn" role="status">{data.warning}</p>}
    {message?.markdown && <Card pad class="result-reader stack-4">
      <div class="result-toolbar"><h2 class="t-title2">Result</h2>{showActions && <div class="pair">
        {showCopy && <Action className="btn btn-secondary" run={copyMessage} success="Message copied.">Copy message</Action>}
        {api&&<Action className="btn btn-secondary" run={downloadMessage} success="Message downloaded.">Download Markdown</Action>}
      </div>}</div>
      {message.truncated&&<p class="t-sm t-2">Showing the first part of the message. Download Markdown to read all of it.</p>}
      <Markdown text={message.markdown}/>
    </Card>}
    {(data.files?.length>0 || data.download_only) && <h2 class="t-title2">Files</h2>}
    {data.download_only&&!data.files?.length&&<p class="t-2">Files are available in the download.</p>}
    {(data.files||[]).map(file=><Card class="result-file" key={file.path}>
      <div class="job-file-head"><code>{file.path.replace(/^(?:faravan-output|faravan-output)\//,'').split(/(?<=\/)/).map(part=><>{part}<wbr/></>)}</code><span class="t-xs t-2">{file.bytes>=1000000?Math.round(file.bytes/100000)/10+' MB':file.bytes>=1000?Math.round(file.bytes/1000)+' KB':file.bytes+' bytes'}</span>{api&&showFileActions&&<Action className="btn btn-secondary btn-sm" run={()=>downloadOutput(api,file.url)} success="File downloaded.">Download</Action>}</div>
      {file.download_only&&<p class="t-sm t-2 card-pad">Preview unavailable. Download this file to review it.</p>}
      {file.preview?<ImagePreview file={{...file,path:file.path.replace(/^(?:faravan-output|faravan-output)\//,'')}} api={api} inline/>:file.text!==undefined?<details class="card-pad"><summary>Preview</summary><pre class="job-code" tabIndex="0">{file.text}</pre>{file.truncated&&<p class="t-xs t-2">Preview shortened. Download the file to read all of it.</p>}</details>:null}
    </Card>)}
    {data.more_files>0&&<p>{data.more_files} {data.download_only || data.files?.length > 1 ? "more files are included in the download." : "additional files are not available to download here."}</p>}
  </section>;
}
