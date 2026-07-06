'use strict';

// Mini-cockpit (PiP) renderer. Receives a small state payload from the main window
// and shows the single most relevant thing: an imminent meeting, the next meeting
// countdown, or the clock - with a task glance + Join.

const byId = (id) => document.getElementById(id);
let data = { meeting: null, tasksOpen: 0, tasksOverdue: 0 };
let meetLink = '';

window.sshApi.onPipData((d) => {
  if (d) data = d;
  render();
});

function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  return m + ':' + String(s).padStart(2, '0');
}

function nowClock() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shortName(s) {
  s = s || '';
  return s.length > 18 ? s.slice(0, 17) + '…' : s;
}

function render() {
  const primary = byId('pip-primary');
  const secondary = byId('pip-secondary');
  const foot = byId('pip-foot');
  const now = Date.now();
  const m = data.meeting;
  const lead = m ? m.startMs - now : Infinity;
  const alerting = m && lead <= 3 * 60000 && now < m.startMs + 15 * 60000;
  document.body.classList.toggle('alert', !!alerting);
  meetLink = (m && m.meetLink) || '';

  // Priority: imminent meeting -> upcoming meeting (<=60m) -> clock.
  if (alerting) {
    primary.textContent = lead >= 0 ? '📅 ' + fmtCountdown(lead) : '📅 now';
    secondary.textContent = m.summary || 'Meeting';
  } else if (m && lead <= 60 * 60000) {
    primary.textContent = '📅 ' + fmtCountdown(lead);
    secondary.textContent = m.summary || 'Meeting';
  } else {
    primary.textContent = '🕐 ' + nowClock();
    secondary.textContent = m ? 'Next: ' + shortName(m.summary) : 'No meetings';
  }

  // Footer: task glance + a Join button when the active meeting has a link.
  foot.innerHTML = '';
  const tasks = document.createElement('span');
  tasks.className = 'pip-tasks';
  if (data.tasksOverdue > 0) {
    tasks.textContent = '⚠ ' + data.tasksOverdue + ' overdue';
    tasks.classList.add('overdue');
  } else {
    tasks.textContent = '☑ ' + (data.tasksOpen || 0) + ' open';
  }
  foot.appendChild(tasks);
  if (meetLink) {
    const join = document.createElement('button');
    join.className = 'pip-join';
    join.textContent = 'Join';
    join.title = meetLink;
    join.addEventListener('click', (e) => {
      e.stopPropagation();
      window.sshApi.openExternal(meetLink);
    });
    foot.appendChild(join);
  }
}

// Click the window (outside buttons) → bring the main Cockpit window forward.
document.body.addEventListener('click', () => window.sshApi.pipFocusMain());

// Tick locally so countdowns/clock stay smooth between pushes from the main window.
setInterval(render, 1000);
render();
