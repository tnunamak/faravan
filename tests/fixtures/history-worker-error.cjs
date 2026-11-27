const {parentPort} = require('node:worker_threads');
parentPort.postMessage({type:'progress',file:'/synthetic/broken.jsonl',metadata:{provider:'claude',account:'claude'}});
parentPort.postMessage({type:'error',message:'synthetic read failure',stats:{skippedFiles:0,skippedFilePaths:[],droppedItems:[]}});
