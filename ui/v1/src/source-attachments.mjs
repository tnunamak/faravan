// Attachment bytes live in IndexedDB, separate from small, synchronously readable draft metadata.
// A restored uncertain send waits for these exact bytes before it can retry its original draft id.
const STORE='attachments';
async function database() {
 if(!globalThis.indexedDB)throw Object.assign(new Error('This browser cannot save attachments. Use a browser with local storage enabled.'),{code:'attachment_storage'});
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open('faravan-source-drafts',1);
  request.onupgradeneeded=()=>request.result.createObjectStore(STORE);
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(Object.assign(new Error('Could not open saved attachments. Check the browser’s storage settings.'),{code:'attachment_storage'}));
  request.onblocked=()=>reject(Object.assign(new Error('Close other Faravan tabs, then reload to open saved attachments.'),{code:'attachment_storage'}));
 });
}
async function transaction(mode,action) {
 const db=await database();
 try {
  return await new Promise((resolve,reject)=>{
   const tx=db.transaction(STORE,mode);let result;
   const request=action(tx.objectStore(STORE));request.onsuccess=()=>{result=request.result;};
   tx.oncomplete=()=>resolve(result);
   tx.onerror=tx.onabort=()=>reject(Object.assign(new Error('Could not save or restore the selected files. Free browser storage, then try again.'),{code:'attachment_storage'}));
  });
 }finally{db.close();}
}
export const saveAttachment = (id,selection) => transaction('readwrite',store=>store.put(selection,id));
export async function loadAttachment(id) {
 const selection=await transaction('readonly',store=>store.get(id));
 if(!selection)throw Object.assign(new Error('The saved files are no longer in this browser. Your original send has not been retried.'),{code:'attachment_missing'});
 return selection;
}
export const removeAttachment = id => id ? transaction('readwrite',store=>store.delete(id)) : Promise.resolve();
