export function invitationVM(item,formatDate) {
  const states={issued:'Issued',join_status_unavailable:'Join status unavailable',approval_unconfirmed:'Approval not confirmed',waiting:'Waiting for approval',claimed:'Used',expired:'Expired',revoked:'Revoked',revocation_unconfirmed:'Revoke not confirmed',publication_unconfirmed:'Publication not confirmed'};
  const count = (value, label, unavailable) => Number.isSafeInteger(value) && value >= 0 ? value + ' ' + label : unavailable;
  const unconfirmed = count(item.unconfirmed, 'not confirmed', 'Not-confirmed count unavailable');
  const waiting = count(item.waiting, 'waiting', 'Waiting count unavailable');
  const approved = count(item.approved, 'approved', 'Approval count unavailable');
  return {id:item.id,title:item.label?.trim() || item.audience?.trim() || (item.maxUses>1?'Group chat':'One computer'),state:states[item.state]??'Status unavailable',
    created:'Created '+formatDate(item.createdAt),expires:'Expires '+formatDate(item.expiresAt),
    usage:approved+' · '+(item.unconfirmed===0?'':unconfirmed+' · ')+waiting+' · Up to '+item.maxUses+' '+(item.maxUses===1?'computer':'computers'),
    canRevoke:!['revoked','expired'].includes(item.state)};
}
