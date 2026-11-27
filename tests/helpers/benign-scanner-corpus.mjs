// Plausible coding-agent output that must pass the outbound credential scan.
// Each sample is built around one hyphenated identifier or path that contains a token-looking prefix inside a word.
const sample=(...lines)=>lines.join('\n');
export const benignCorpus=[
 {id:1,text:sample("import {protectLedger} from './disk-sweep-schedule-protection-ledger.mjs';","Updated the import path after the rename.")},
 {id:2,text:sample("The disk-sweep-schedule-protection-ledger identifier now tracks protected paths.","No other module reads it.")},
 {id:3,text:sample("Added task-continuation-summary-generation to the handoff builder.","Tests for the summary pass.")},
 {id:4,text:sample("Moved desk-workspace-layout-sidebar-navigation into the shared layout.","The sidebar keeps its width on resize.")},
 {id:5,text:sample("Wired ask-before-publishing-confirmation to the publish button.","A cancelled dialog leaves the draft unchanged.")},
 {id:6,text:sample("The risk-resource-capacity-accounting module sums reserved disk and memory.","It runs once per lending window.")},
 {id:7,text:sample("diff --git a/src/task-runner-retry-backoff-controller.ts b/src/task-runner-retry-backoff-controller.ts","@@ -12,3 +12,4 @@","+export const maxDelayMs = 30000;")},
 {id:8,text:sample(".task-summary-panel--completed {","  border-color: var(--ok);","}")},
 {id:9,text:sample(".desk-navigation-sidebar--collapsed {","  width: 48px;","}")},
 {id:10,text:sample("Added the mask-image-rendering-fallback-state class for older browsers.","Verified in the preview build.")},
 {id:11,text:sample("Renamed the helper to task-subscription-renewal-window-complete.","The caller now awaits it.")},
 {id:12,text:sample("Fixed the risk-ant-code-generation-manager module.","It no longer retries after a refusal.")},
 {id:13,text:sample("Split disk-ant-recovery-state-transitions into two files.","Each file has its own test.")},
 {id:14,text:sample("import {load} from './task-scheduler-initialization-configuration.mjs';","The loader reads defaults once.")},
 {id:15,text:sample("Renamed risk-resource-capacity-accounting and disk-sweep-schedule-protection-ledger together.","Both imports were updated in src/task-runner-retry-backoff-controller.ts.")},
 {id:16,text:"Cleared the disk-cache-v2 folder and restarted the task-runner."},
 {id:17,text:"Added an ask-question prompt and a desk-layout toggle."},
 {id:18,text:"Edited card-header.tsx and added the button--primary variant."},
 {id:19,text:"Regenerated package-lock.json and updated README.md."},
 {id:20,text:sample("All 48 tests passed in 12.3 seconds.","One test was skipped because it needs a display.")},
];
