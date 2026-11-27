import {errorMessage} from './helpers.mjs';
import {useState,useRef,useLayoutEffect} from 'preact/hooks';
import {Button,Card} from './ds/index.mjs';
import {Markdown} from './result-reader.jsx';
export function AgentQuestion({question,questionId,onAnswer}) {
  // A new result or changed question gets a new editor, never the previous answer.
  return <QuestionEditor key={JSON.stringify([questionId??null,question])} {...{question,onAnswer}} />;
}
function QuestionEditor({question,onAnswer}) {
  const [answer,setAnswer]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[succeeded,setSucceeded]=useState(false);
  const gate=useRef(false),active=useRef(true);
  useLayoutEffect(()=>()=>{active.current=false;},[]);
  if(!question)return null;
  return <Card pad class="stack-3 agent-question ph-no-capture" data-telemetry-private="agent-question"><h2 class="t-title2">The agent has a question</h2><Markdown className="agent-question-markdown" text={question}/>{!onAnswer&&<p class="t-xs t-2">This run has ended. A follow-up is not available for this result.</p>}{onAnswer&&<form class="stack-3" onSubmit={async e=>{
    e.preventDefault();if(!active.current||!answer.trim()||gate.current)return;
    gate.current=true;setBusy(true);setError('');
    const request='Answer to the agent’s question: '+question+'\n\n'+answer.trim(),prepare=onAnswer;
    try{await prepare(request);if(active.current)setSucceeded(true);}
    catch(error){gate.current=false;if(active.current)setError(errorMessage(error));}
    finally{if(active.current)setBusy(false);}
  }}>
    <label class="field">Your answer<textarea class="input" rows="3" maxLength="8000" value={answer} required disabled={busy||succeeded} onInput={e=>setAnswer(e.currentTarget.value)} /></label><p class="t-xs t-2">{answer.length} / 8000 characters</p><p class="t-xs t-2">{succeeded?'Your answer prepared a follow-up job from this result, using its handoff. A lender must accept it.':'Your answer prepares a new job from this result, using its handoff. A lender must accept it.'}</p><div><Button type="submit" disabled={!answer.trim()||busy||succeeded} disabledReason={busy?'Sending your answer…':succeeded?'Your answer was sent.':'Write your answer first'}>{busy?'Preparing…':succeeded?'Follow-up prepared':'Prepare follow-up'}</Button></div>{error&&<p class="form-error" role="alert">{error}</p>}
  </form>}</Card>;
}
