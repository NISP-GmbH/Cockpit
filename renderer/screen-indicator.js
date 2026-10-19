// The always-on-top pill while a program in a terminal may control the screen (screen-control.js
// paints it once a second, and at the start and end of every action: lit while one runs, saying
// what). Stop revokes every grant at once, like Ctrl+Alt+Esc. In step mode it also asks before
// each click / key / typing: OK, Skip, or Let it run (step mode off for that terminal). The window never takes the focus, so answering leaves it where the action goes.
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
  const pill = document.getElementById('pill');
  const icon = document.getElementById('icon');
  let lastSeq = null;
  const ago = (s) => (s < 60 ? s + ' s' : Math.round(s / 60) + ' min');
  api.onScreenIndicator((d) => {
    const items = (d && d.items) || [];
    const one = (it) => '<b>' + esc(it.title) + '</b>' + (it.left == null ? '' : ' · ' + it.left + ' min');
    const stopKey = esc((d && d.stopKey) || 'Ctrl+Alt+Esc');
    const act = (d && d.activity) || {};
    const now = act.now;
    const last = act.last;
    pill.classList.toggle('act', !!now && now.kind === 'act');
    pill.classList.toggle('look', !!now && now.kind === 'look');
    if (now) {
      // what runs right now, in words; a new action flashes the pill once
      text.innerHTML = '<b>' + esc(now.who) + '</b> is ' + esc(now.what) + ' · ' + stopKey;
      icon.textContent = now.icon;
      icon.className = now.icon === '🖱' ? 'mouse' : now.icon === '⌨' ? 'keys' : 'other';
      if (now.seq !== lastSeq) {
        lastSeq = now.seq;
        pill.classList.remove('flash');
        void pill.offsetWidth; // restart the animation
        pill.classList.add('flash');
      }
    } else {
      text.innerHTML =
        (items.length === 1 ? one(items[0]) : items.map(one).join(', ')) +
        ' · <span id="idle">' + (last ? 'idle ' + ago(last.ago_s) : 'nothing done yet') + '</span> · ' + stopKey;
    }
    text.title =
      (items.length === 1 ? items[0].title + ' may control the screen' : items.map((i) => i.title).join(', ') + ' may control the screen') +
      (last ? '. Last: ' + last.who + ' ' + last.what + ', ' + ago(last.ago_s) + ' ago' : '');
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
