// The always-on-top pill while a program in a terminal may control the screen (screen-control.js
// paints it once a second). Stop revokes every grant at once, like Ctrl+Alt+Esc. In step mode it
// also asks before each click / key / typing: OK, Skip, or Let it run (step mode off for that
// terminal). The window never takes the focus, so answering leaves it where the action goes.
(function () {
  const api = window.sshApi;
  const text = document.getElementById('text');
  const stepBtn = document.getElementById('stepbtn');
  const ask = document.getElementById('ask');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let stepId = null;
  let stepOn = false;
  document.getElementById('stop').addEventListener('click', () => api.screenStop());
  stepBtn.addEventListener('click', () => api.screenStepMode(!stepOn));
  for (const [id, choice] of [
    ['ok', 'ok'],
    ['skip', 'skip'],
    ['all', 'all'],
  ])
    document.getElementById(id).addEventListener('click', () => stepId != null && api.screenStepAnswer(stepId, choice));
  api.onScreenIndicator((d) => {
    const items = (d && d.items) || [];
    const one = (it) => '<b>' + esc(it.title) + '</b>' + (it.left == null ? '' : ' · ' + it.left + ' min');
    text.innerHTML =
      (items.length === 1 ? one(items[0]) + ' controls the screen' : items.map(one).join(', ') + ' control the screen') +
      ' · ' + esc((d && d.stopKey) || 'Ctrl+Alt+Esc');
    text.title = text.textContent;
    stepOn = !!(d && d.stepMode);
    stepBtn.classList.toggle('on', stepOn);
    stepBtn.textContent = stepOn ? 'Step: on' : 'Step';
    const q = d && d.step;
    stepId = q ? q.id : null;
    ask.hidden = !q;
    if (q) {
      // the same box asks a step question, or - while watch_me records - shows what to do and Done
      const teach = !!q.teach;
      ask.classList.toggle('teach', teach);
      document.getElementById('askwhat').innerHTML = teach
        ? '🎓 <b>' + esc(q.who) + '</b> asks you to show it: <b>' + esc(q.title) + '</b>'
        : '<b>' + esc(q.who) + '</b> wants to: <b>' + esc(q.title) + '</b>' + (q.target ? ' in ' + esc(q.target) : '');
      document.getElementById('askprev').textContent = q.preview || '';
      document.getElementById('ok').textContent = teach ? 'Done' : 'OK';
      document.getElementById('skip').textContent = teach ? 'Cancel' : 'Skip';
      document.getElementById('all').hidden = teach;
      document.getElementById('askkey').textContent = (q.okKey || 'Ctrl+Alt+Enter') + (teach ? ' = Done' : ' = OK');
    }
  });
})();
