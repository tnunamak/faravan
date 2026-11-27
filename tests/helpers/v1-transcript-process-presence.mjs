// `idleReader` is the app's active-presence callback; the transcript journey requires the owner to be absent.
export const TRANSCRIPT_PROCESS_OWNER_ABSENT = true;
export const transcriptProcessUserActive = async () => !TRANSCRIPT_PROCESS_OWNER_ABSENT;
