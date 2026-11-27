// What a person could free while a job waits for disk space. The server read it (lib/disk-wait.mjs);
// Faravan only shows it and never removes anything. `disk` is the item's `disk` value.
export function diskHelpVM(disk) {
  const reclaim = disk?.reclaim;
  if (!reclaim) return null;
  const docker = reclaim.docker
    ? { heading: reclaim.docker.items.length
        ? 'Largest unused Docker items. Removing one deletes its data for good, so check it first. Faravan does not remove them.'
        : 'Docker shows no unused images or volumes to remove.',
      items: reclaim.docker.items.map(item => ({ label: `${item.kind === 'volume' ? 'Volume' : 'Image'} ${item.name}`, size: item.size, command: item.command })),
      listCommand: reclaim.docker.command }
    : null;
  const faravan = Array.isArray(reclaim.faravan) && reclaim.faravan.length
    ? { heading: 'Faravan’s own leftovers:', names: reclaim.faravan.map(item => item.name) } : null;
  return docker || faravan ? { docker, faravan } : null;
}
