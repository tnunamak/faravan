import {isSessionLost, isTransportFailure} from './helpers.mjs';
export const filterProjects = (projects = [], query = '') => {
  const needle = query.trim().toLocaleLowerCase();
  return projects.filter(project => (project.name + ' ' + project.path).toLocaleLowerCase().includes(needle));
};
export const homePath = (path, home) => home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
export function folderCrumbs(path, home) {
  if (!home || !path || (path !== home && !path.startsWith(home + '/'))) return [];
  let current = home;
  return [{name:'Home', path:home}, ...path.slice(home.length).split('/').filter(Boolean).map(name => ({name, path:current += '/' + name}))];
}

// One pending timer and request per field. Epochs also guard transports that ignore abort.
export function createRepoChecker({inspect, onResult, onChecking = () => {}, setTimer = setTimeout, clearTimer = clearTimeout}) {
  let timer, controller, checking, epoch = 0, disposed = false;
  const cancel = () => {
    clearTimer(timer); timer = undefined;
    controller?.abort(); controller = null; checking = null; epoch++;
  };
  const check = async path => {
    clearTimer(timer); timer = undefined;
    if (disposed || checking === path) return;
    cancel();
    if (!path.trim()) { onResult({status:'idle'}); return; }
    const version = epoch;
    controller = new AbortController(); checking = path; onChecking();
    try {
      const info = await inspect(path, controller.signal);
      if (disposed || version !== epoch) return;
      onResult(info.refusal ? {status:'refused', refusal:info.refusal} : {status:'ok', info});
    } catch (error) {
      if (disposed || version !== epoch || error.name === 'AbortError') return;
      onResult({status:'refused', refusal:error.repoRefusal ?? {state:isSessionLost(error) ? 'compose.session-lost' : isTransportFailure(error) ? 'compose.check-failed' : 'compose.repo-missing'}});
    } finally { if (version === epoch) { controller = null; checking = null; } }
  };
  return {
    check,
    schedule(path) { cancel(); if (path.trim()) timer = setTimer(() => check(path), 500); else onResult({status:'idle'}); },
    cancel,
    dispose() { disposed = true; cancel(); },
  };
}
