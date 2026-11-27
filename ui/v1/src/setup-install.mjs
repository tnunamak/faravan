// O6: what a person needs to install Docker Sandboxes. Pure facts; setup.jsx decides desktop or phone.
const GUIDE = 'https://docs.docker.com/ai/sandboxes/install/';
const ANCHOR = {mac: '#install-on-macos', macos: '#install-on-macos', windows: '#install-on-windows', linux: '#install-on-ubuntu'};

export function dockerInstallVM({platform, remedy} = {}) {
  const command = String(remedy ?? '').trim();
  return {
    managed: platform === 'mac' || platform === 'macos',
    terminal: command ? 'On the computer running Faravan, open a terminal and run this command to install Docker Sandboxes.' : 'Install Docker Sandboxes on the computer running Faravan.',
    explain: 'Installs Docker Sandboxes, the tool Faravan uses to run jobs in a sandbox.',
    phone: 'Do this on the computer, not on this device.',
    after: 'Return here after installation. Faravan will check again while this page is connected.',
    link: {label: 'Open Docker installation instructions', href: GUIDE + (typeof platform === 'string' && Object.hasOwn(ANCHOR, platform) ? ANCHOR[platform] : '')},
    command,
  };
}

const COMMAND = /^(?:sudo|sbx|faravan|faravan|docker|brew|npm|git|curl|winget|systemctl)\s/;
const sentence = text => { const t = text.trim().replace(/[.:]+$/, ''); return t ? t[0].toUpperCase() + t.slice(1) + '.' : ''; };

// Splits a checker's remedy into prose and copyable commands. Nothing is dropped: an unfamiliar remedy stays as prose.
export function setupRemedyVM(remedy = '') {
  const text = String(remedy).trim();
  const quoted = [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(command => COMMAND.test(command));
  let commands = quoted, prose = text;
  if (!quoted.length && COMMAND.test(text)) {
    // "<command> (aside)" or "<command> (or run: <command>)": the aside is prose or a second command.
    const aside = /^(.*?)\s*\((.*)\)\s*$/.exec(text);
    commands = [aside ? aside[1] : text]; prose = '';
    if (aside) {
      const alternative = /^or run:\s*(.+)$/i.exec(aside[2]);
      if (alternative && COMMAND.test(alternative[1])) commands.push(alternative[1].trim());
      else prose = sentence(aside[2]);
    }
  } else if (!quoted.length) commands = [];
  const first = commands[0] || '';
  const explanation = first.startsWith('sudo usermod') ? 'Gives your user permission to run sandboxes. Sign out and back in afterward.'
    : /^sbx (?:system|daemon)/.test(first) ? 'Starts Docker Sandboxes so jobs can run.'
    : /^sbx policy/.test(first) ? 'Sets the sandbox network rules each job checks.'
    : 'Run this command to address the setup check described above.';
  return {text: prose, commands, explanation};
}
