import {errorMessage} from './helpers.mjs';
import {useEffect, useRef, useState} from 'preact/hooks';
import {Button, Icon, Sheet, Spinner} from './ds/index.mjs';
import {filterProjects, folderCrumbs, homePath} from './project-picker-model.mjs';
import {hostComputerReference, nameHostComputerInCopy} from './view-models.mjs';

export function ProjectRow({project, home, onChoose, onBrowse, disabled = false}) {
  const navigable = project.is_git === false;
  if(project.stale)return <div class="project-row project-stale ph-no-capture" data-telemetry-private="project-picker"><Icon name="folder"/><span class="project-row-text"><strong>{project.name}</strong><span class="t-sm t-2 project-path">{homePath(project.path,home)} · No longer available</span></span><span class="t-xs t-2">Choose another folder</span></div>;
  return <button type="button" class="project-row ph-no-capture" disabled={disabled} data-picker-row
    onClick={() => navigable ? onBrowse(project.path) : onChoose(project.path)} data-telemetry-private="project-picker">
    <Icon name="folder" />
    <span class="project-row-text"><strong>{project.name}</strong><span class="t-sm t-2 project-path">{homePath(project.path, home)}</span></span>
    {project.branch && <span class="project-chip project-branch" title={project.branch}>{project.branch}</span>}
    {navigable && <Icon name="chev-r" size="sm" />}
  </button>;
}
function moveFocus(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key) || !event.target.matches('[data-picker-row],input[type=search]')) return;
  if (['Home','End'].includes(event.key) && event.target.matches('input[type=search]')) return;
  const rows = [...event.currentTarget.querySelectorAll('[data-picker-row]')];
  if (!rows.length) return;
  if (event.key === 'Enter') {
    if (event.target.matches('input')) { event.preventDefault(); rows[0].click(); }
    return;
  }
  event.preventDefault();
  if (event.key === 'Home' || event.key === 'End') {
    rows[event.key === 'Home' ? 0 : rows.length - 1].focus();
    return;
  }
  const current = rows.indexOf(event.target), step = event.key === 'ArrowDown' ? 1 : -1;
  rows[current < 0 ? (step === 1 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length].focus();
}
export function ProjectPickerBody({data, browse, query = '', loading, browsing, error, browseError, onQuery, onBrowse, onChoose, onClose, viewerSession, computerName}) {
  const computer = hostComputerReference(viewerSession, computerName), copy = text => nameHostComputerInCopy(text, computer);
  const home = browse?.home, showSuggestions=!browse?.path || browse.path===home;
  const recent = showSuggestions?filterProjects(data?.recent, query):[];
  const recentPaths=new Set(recent.filter(project=>!project.stale).map(project=>project.path));
  const repos = showSuggestions?filterProjects(data?.repos, query).filter(project=>!recentPaths.has(project.path)):[];
  const shownPaths=new Set([...recent,...repos].filter(project=>!project.stale).map(project=>project.path));
  const folders = filterProjects(browse?.folders, query).filter(project=>!showSuggestions || !project.is_git || !shownPaths.has(project.path)), crumbs = folderCrumbs(browse?.path, home);
  const noProjects = data && !data.recent.length && !data.repos.length;
  return <div class="project-picker ph-no-capture" onKeyDown={moveFocus} data-telemetry-private="project-picker">
    <header class="project-picker-heading"><h2 class="t-title2">Choose a project</h2><Button kind="quiet" onClick={onClose} aria-label="Close project picker"><Icon name="x" /></Button></header>
    <div class="project-search"><label for="project-search" class="sr">Search projects</label><Icon name="search" /><input id="project-search" class="input" type="search" placeholder="Search by name or path" value={query} onInput={event => onQuery(event.currentTarget.value)} autoFocus autocomplete="off" /></div>
    <div class="project-picker-content">
      {loading && <p class="t-sm t-2" role="status"><Spinner />{copy(' Finding projects on this computer…')}</p>}
      {error && <p class="t-sm folder-error" role="alert">{error} <button type="button" class="linklike" onClick={() => onBrowse(home || '')}>Browse folders</button></p>}
      {recent.length > 0 && <section aria-labelledby="project-recent"><h3 id="project-recent">Recent</h3><div class="project-rows">{recent.map(project => <ProjectRow key={project.path} {...{project,home,onChoose,onBrowse}} />)}</div></section>}
      {showSuggestions && data && (repos.length>0 || noProjects || query || data.truncated) && <section aria-labelledby="project-discovered"><h3 id="project-discovered">{copy('Projects on this computer')}</h3>
        {repos.length > 0 && <div class="project-rows">{repos.map(project => <ProjectRow key={project.path} {...{project,home,onChoose,onBrowse}} />)}</div>}
        {noProjects && !query && <p class="project-empty t-sm t-2">No projects found. <button type="button" class="linklike" onClick={() => {onQuery('');onBrowse(home || '');}}>Browse folders</button> to find your project.</p>}
        {query && !recent.length && !repos.length && <p class="project-empty t-sm t-2">No projects match “{query}”. Browse folders or type a path in the Project field.</p>}
        {data.truncated && <p class="project-scan-note t-xs t-2">Scan limited to {data.repos.length} projects; browse or type a path for others</p>}
      </section>}
      <section class="project-browse" aria-labelledby="project-browse"><h3 id="project-browse">Browse</h3>
        <nav class="project-crumbs" aria-label="Folder location">{(crumbs.length ? crumbs : [{name:'Home',path:''}]).map((crumb,index,list) => <span key={crumb.path}>{index > 0 && <Icon name="chev-r" size="sm" />}<button type="button" aria-current={index === list.length - 1 ? 'location' : undefined} onClick={() => {onQuery('');onBrowse(crumb.path);}}>{crumb.name}</button></span>)}</nav>
        {browse && !browsing && !browseError && <Button kind="secondary" onClick={()=>onChoose(browse.path)}>Choose this folder</Button>}
        {browsing ? <p class="project-empty t-sm t-2" role="status"><Spinner /> Loading folders…</p> : browseError ? <p class="project-empty t-sm folder-error" role="alert">{browseError}</p> : <div class="project-rows">{folders.map(project => <ProjectRow key={project.path} {...{project,home,onChoose,onBrowse}} />)}{browse && !folders.length && <p class="project-empty t-sm t-2">{query ? 'No other folders match this search.' : 'No other subfolders here.'}</p>}</div>}
      </section>
    </div>
    <p class="project-picker-foot t-xs t-2">{copy('Projects stay on this computer until you send a job.')}</p>
  </div>;
}
export function ProjectPicker({api, onChoose, onClose, viewerSession, computerName}) {
  const [data,setData] = useState(null), [browse,setBrowse] = useState(null), [query,setQuery] = useState('');
  const [loading,setLoading] = useState(true), [browsing,setBrowsing] = useState(true);
  const [error,setError] = useState(''), [browseError,setBrowseError] = useState('');
  const browseRequest = useRef(null);
  async function loadFolders(path = '') {
    browseRequest.current?.abort();
    const request = new AbortController(); browseRequest.current = request;
    setBrowsing(true); setBrowseError('');
    try { const next = await api.get('folders?path=' + encodeURIComponent(path),request.signal); if (!request.signal.aborted) setBrowse(next); }
    catch (error) { if (!request.signal.aborted) setBrowseError(errorMessage(error)); }
    finally { if (!request.signal.aborted) setBrowsing(false); }
  }
  useEffect(() => {
    const request = new AbortController();
    api.get('folders/suggest',request.signal).then(next => { if (!request.signal.aborted) setData(next); }).catch(error => { if (!request.signal.aborted) setError(errorMessage(error)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    loadFolders();
    return () => {request.abort();browseRequest.current?.abort();};
  },[]);
  return <Sheet class="ph-no-capture" open label="Choose a project" onClose={onClose} data-telemetry-private="project-picker"><ProjectPickerBody {...{data,browse,query,loading,browsing,error,browseError,onChoose,onClose,viewerSession,computerName}} onQuery={setQuery} onBrowse={path => {setQuery('');loadFolders(path);}} /></Sheet>;
}
