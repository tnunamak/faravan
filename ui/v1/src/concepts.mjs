// The concept registry (PRODUCT-UX-FIELD-RESEARCH §15): one row per product concept with the UI term, what it means,
// the words that are allowed in a scope, the forms that are retired, and the literals the API and CLI keep.
// tests/copy-vocabulary.test.mjs reads `RETIRED_FORMS` from here, so retiring a word is one edit in this file.
// Pure data: no product code imports it at run time.

export const CONCEPTS = Object.freeze([
  {id: 'job', term: 'job', definition: 'One piece of work someone asks a circle to do.',
    aliases: {}, retired: [], literals: {api: 'job', cli: 'job'}, owner: 'jobs',
    examples: ['New job', 'Your job is ready to review.']},
  {id: 'run', term: 'run', definition: 'One time a computer worked on a job. A job can have more than one run.',
    aliases: {}, retired: [{text: 'attempt', reason: 'protocol word; the UI says run'}], literals: {api: 'attempt', cli: 'attempt'}, owner: 'jobs',
    examples: ['The second run is working.']},
  {id: 'result', term: 'result', definition: 'What a run sent back: the agent’s summary, Faravan’s check and the changes.',
    aliases: {}, retired: [], literals: {api: 'result', cli: 'result'}, owner: 'results', examples: ['Review the result']},
  {id: 'request', term: 'request', definition: 'A job waiting for your answer before your computer runs it. Never a run.',
    aliases: {}, retired: [], literals: {api: 'approval', cli: 'approval'}, owner: 'lending', examples: ['Review Sam’s request']},
  {id: 'computer', term: 'computer', definition: 'A machine with Faravan on it. “Device” is internal only.',
    aliases: {api: ['device'], cli: ['device']}, owner: 'shell',
    retired: [{text: 'Unnamed device', reason: 'a computer with no name is “Unnamed computer”; a person is “A circle member”'}],
    literals: {api: 'device', cli: 'device'}, examples: ['This computer', 'Unnamed computer']},
  {id: 'person', term: 'circle member', definition: 'A person in one of your circles. Fallback ladder: your nickname → their name → “a circle member”.',
    aliases: {}, owner: 'circles',
    retired: [{text: 'Someone', whole: true, reason: 'the fallback for a person is “A circle member”'}],
    literals: {api: 'member', cli: 'member'}, examples: ['A circle member asked for help.']},
  {id: 'agent', term: 'agent', definition: 'The coding tool that does the work, such as Claude Code or Codex.',
    aliases: {api: ['harness'], cli: ['harness']}, retired: [], literals: {api: 'harness', cli: '--harness'}, owner: 'lending',
    examples: ['Agents you lend']},
  {id: 'not-now', term: 'Not now', definition: 'A lender passes on a request. The job stays open for other computers.',
    aliases: {api: ['skip', 'decline']}, retired: [], literals: {api: 'skip', cli: 'decline'}, owner: 'lending', examples: ['Not now']},
  {id: 'stop', term: 'Stop', definition: 'A request to stop a running job. It is a request until the computer confirms the job stopped.',
    aliases: {}, owner: 'jobs',
    retired: [{text: 'The job stops now', reason: 'overpromises; stopping is a request until confirmed'}],
    literals: {api: 'stop', cli: 'stop'}, examples: ['Faravan asks the agent to stop.']},
  {id: 'new-job', term: 'New job', definition: 'The composer, on every surface.',
    aliases: {}, owner: 'send',
    retired: [{text: 'What do you want done?', reason: 'the composer is “New job” everywhere'},
      {text: 'What should the agent do?', reason: 'the composer is “New job” everywhere'}],
    literals: {}, examples: ['New job']},
  {id: 'circle', term: 'circle', definition: 'A group of people who lend and borrow agent time with each other.',
    aliases: {}, retired: [{text: 'collective', reason: 'old name; the CLI keeps --collective-name as an alias of --circle-name'}],
    literals: {api: 'circle', cli: '--circle-name'}, owner: 'circles', examples: ['Your circles']},
].map(concept => Object.freeze(concept)));

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// [word, pattern] pairs for the copy test. A `whole` form matches only a literal that is exactly that word,
// so “Someone” as a fallback is caught but “Someone else’s code” is not. Forms the test already bans
// by its own list (attempt, collective) are left to it.
export const RETIRED_FORMS = Object.freeze(CONCEPTS.flatMap(concept => concept.retired
  .filter(form => !['attempt', 'collective'].includes(form.text))
  .map(form => Object.freeze([form.text, form.whole ? new RegExp('^' + escape(form.text) + '$', 'g') : new RegExp(escape(form.text), 'g')]))));
