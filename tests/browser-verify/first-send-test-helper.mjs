export async function confirmFirstSend(page, {required = false} = {}) {
  const notice = page.getByRole('dialog', {name:'Before your first job goes to a friend'});
  await notice.waitFor({state:'visible', timeout:required ? 10000 : 500}).catch(error => {
    if (required) throw new Error('first-send notice did not appear for a fresh friend', {cause:error});
  });
  if (!await notice.isVisible()) return false;
  await notice.getByRole('button', {name:'Send job', exact:true}).click();
  return true;
}
