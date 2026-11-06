export function resolveAutoShareStatus(canApprove) {
  return canApprove === true ? 'Approved' : 'Pending';
}
