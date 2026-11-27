// A question is declared by the final assistant message, never inferred from punctuation or tool output.
export function agentQuestionVM(summary='') {
  let fence=null,question='';const body=[];
  for(const line of String(summary).split('\n')) {
    const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(fence){
      if(marker&&marker[1][0]===fence.char&&marker[1].length>=fence.length&&/^[ \t\r]*$/.test(marker[2]))fence=null;
      body.push(line);continue;
    }
    // A backtick opener's info string cannot contain backticks.
    if(marker&&(marker[1][0]==='~'||!marker[2].includes('`'))){
      fence={char:marker[1][0],length:marker[1].length};body.push(line);continue;
    }
    if(!question&&/^QUESTION:\s*\S/.test(line)){
      const fullQuestion=line.replace(/^QUESTION:\s*/,'').trim();
      question=fullQuestion.slice(0,2000);
      if(fullQuestion.length>2000){question+='… (question shortened; full text in the result)';body.push(fullQuestion);}
    } else body.push(line);
  }
  return {question,body:body.join('\n').trim()};
}
export function agentQuestion(summary='') {return agentQuestionVM(summary).question;}
