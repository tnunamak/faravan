// SSE framing and replay share a byte budget: JSON character counts omit UTF-8
// expansion and the transport envelope.
export const EVENT_REPLAY_BYTES=512*1024;
export const eventFrame=event=>'id: '+event.id+'\nevent: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n';
export function createEventReplay({initialId=0}={}) {
  const rows=[];let bytes=0,latest=initialId,trimmedThrough=initialId;
  return {
    // A transcript chunk goes to open streams only. Pages read transcripts themselves, so chunks are not kept for
    // replay, where a busy job would push job and approval events out of the window. A readiness signal is the same:
    // it only tells open pages to read now (a reconnecting page reads everything anyway), and it is not activity.
    append(event){const frame=eventFrame(event);latest=event.id;
      if(event.type==='lending'&&event.data?.status==='transcript'||event.type==='readiness')return frame;
      rows.push({event,frame});bytes+=Buffer.byteLength(frame);
      while(rows.length>2000||bytes>EVENT_REPLAY_BYTES){const removed=rows.shift();bytes-=Buffer.byteLength(removed.frame);trimmedThrough=removed.event.id;}
      return frame;
    },
    framesAfter(after){
      // The retained tail cannot explain a gap. One full read catches the tab up;
      // its new cursor starts at the live edge on this same open stream.
      if(after<trimmedThrough||after>latest)return [eventFrame({id:latest,type:'reset',data:{refresh:true}})];
      return rows.filter(row=>row.event.id>after).map(row=>row.frame);
    },
    since(after){return rows.filter(row=>row.event.id>after).map(row=>row.event);},
  };
}
