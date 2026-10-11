// Service workers cannot create blob URLs; this offscreen document does it for them.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'blob') reply({ url: URL.createObjectURL(new Blob([msg.text], { type: msg.mime })) });
  else if (msg.type === 'revoke') { URL.revokeObjectURL(msg.url); reply({ ok: true }); }
  return false;
});
